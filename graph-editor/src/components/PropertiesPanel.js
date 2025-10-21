import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback, useEffect, useRef } from 'react';
import { useGraphStore } from '@/lib/useGraphStore';
import { generateSlugFromLabel, generateUniqueSlug } from '@/lib/slugUtils';
import ConditionalProbabilitiesSection from './ConditionalProbabilitiesSection';
import { getNextAvailableColor } from '@/lib/conditionalColors';
export default function PropertiesPanel({ selectedNodeId, onSelectedNodeChange, selectedEdgeId, onSelectedEdgeChange }) {
    const { graph, setGraph, whatIfAnalysis, setWhatIfAnalysis } = useGraphStore();
    const [activeTab, setActiveTab] = useState('graph');
    // Local state for form inputs to prevent eager updates
    const [localNodeData, setLocalNodeData] = useState({});
    const [localEdgeData, setLocalEdgeData] = useState({});
    // Case node state
    const [nodeType, setNodeType] = useState('normal');
    const [caseMode, setCaseMode] = useState('manual');
    const [caseData, setCaseData] = useState({
        id: '',
        parameter_id: '',
        status: 'active',
        variants: []
    });
    // Track if user has manually edited the slug to prevent auto-generation
    const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
    // Track if this node has ever had its label committed (to prevent slug regeneration)
    const hasLabelBeenCommittedRef = useRef({});
    // Local state for conditional probabilities (like variants)
    const [localConditionalP, setLocalConditionalP] = useState([]);
    const lastLoadedEdgeRef = useRef(null);
    // JSON edit modal state
    const [showJsonEdit, setShowJsonEdit] = useState(false);
    const [jsonEditContent, setJsonEditContent] = useState('');
    const [jsonEditError, setJsonEditError] = useState(null);
    // Track previous selection to detect actual selection changes
    const prevSelectionRef = useRef({ nodeId: selectedNodeId, edgeId: selectedEdgeId });
    // Auto-switch tabs based on selection ONLY when selection actually changes
    useEffect(() => {
        const selectionChanged = prevSelectionRef.current.nodeId !== selectedNodeId ||
            prevSelectionRef.current.edgeId !== selectedEdgeId;
        if (selectionChanged) {
            if (selectedNodeId) {
                setActiveTab('node');
            }
            else if (selectedEdgeId) {
                setActiveTab('edge');
            }
            else {
                setActiveTab('graph');
            }
            prevSelectionRef.current = { nodeId: selectedNodeId, edgeId: selectedEdgeId };
        }
    }, [selectedNodeId, selectedEdgeId]);
    // Track the last loaded node to prevent reloading on every graph change
    const lastLoadedNodeRef = useRef(null);
    // Load local data when selection changes (but not on every graph update)
    useEffect(() => {
        if (selectedNodeId && graph) {
            // Only reload if we're switching to a different node
            if (lastLoadedNodeRef.current !== selectedNodeId) {
                const node = graph.nodes.find((n) => n.id === selectedNodeId);
                if (node) {
                    setLocalNodeData({
                        label: node.label || '',
                        slug: node.slug || '',
                        description: node.description || '',
                        absorbing: node.absorbing || false,
                        outcome_type: node.outcome_type,
                        tags: node.tags || [],
                        entry: node.entry || {},
                    });
                    // Handle case node data
                    console.log('Loading node data:', node.type, node.case);
                    if (node.type === 'case' && node.case) {
                        console.log('Loading case node:', node.case);
                        setNodeType('case');
                        setCaseData({
                            id: node.case.id || '',
                            parameter_id: node.case.parameter_id || '',
                            status: node.case.status || 'active',
                            variants: node.case.variants || []
                        });
                        setCaseMode(node.case.parameter_id ? 'registry' : 'manual');
                    }
                    else {
                        console.log('Loading normal node');
                        setNodeType('normal');
                        setCaseData({
                            id: '',
                            parameter_id: '',
                            status: 'active',
                            variants: []
                        });
                        setCaseMode('manual');
                    }
                    // Reset manual edit flag when switching to a different node
                    setSlugManuallyEdited(false);
                    // Mark node as having committed label if it already has a label
                    // This prevents slug from auto-updating on subsequent label edits
                    if (node.label && node.label.trim() !== '') {
                        hasLabelBeenCommittedRef.current[selectedNodeId] = true;
                    }
                    lastLoadedNodeRef.current = selectedNodeId;
                }
            }
        }
        else if (!selectedNodeId) {
            // Clear the ref when no node is selected
            lastLoadedNodeRef.current = null;
        }
    }, [selectedNodeId, graph]);
    // Load edge data when selection changes (but not on every graph update)
    useEffect(() => {
        if (selectedEdgeId && graph) {
            // Only reload if we're switching to a different edge
            if (lastLoadedEdgeRef.current !== selectedEdgeId) {
                const edge = graph.edges.find((e) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                if (edge) {
                    setLocalEdgeData({
                        slug: edge.slug || '',
                        probability: edge.p?.mean || 0,
                        stdev: edge.p?.stdev || undefined,
                        description: edge.description || '',
                        costs: edge.costs || {},
                        weight_default: edge.weight_default || 0
                    });
                    setLocalConditionalP(edge.conditional_p || []);
                    lastLoadedEdgeRef.current = selectedEdgeId;
                }
            }
        }
        else if (!selectedEdgeId) {
            // Clear the ref when no edge is selected
            lastLoadedEdgeRef.current = null;
        }
    }, [selectedEdgeId, graph]);
    // Auto-generate slug from label when label changes (only on FIRST commit)
    // This updates the LOCAL state only, not the graph state
    useEffect(() => {
        if (selectedNodeId && graph && localNodeData.label && !slugManuallyEdited) {
            // Check if the node actually exists in the graph to prevent race conditions
            const nodeExists = graph.nodes.some((n) => n.id === selectedNodeId);
            if (!nodeExists) {
                return;
            }
            // For new nodes (no committed label yet), always regenerate slug
            // For existing nodes, only regenerate if label hasn't been committed yet
            const shouldRegenerateSlug = !hasLabelBeenCommittedRef.current[selectedNodeId];
            if (shouldRegenerateSlug) {
                const baseSlug = generateSlugFromLabel(localNodeData.label);
                if (baseSlug && baseSlug !== localNodeData.slug) {
                    // Get all existing slugs (excluding current node)
                    const existingSlugs = graph.nodes
                        .filter((n) => n.id !== selectedNodeId)
                        .map((n) => n.slug)
                        .filter(Boolean);
                    const uniqueSlug = generateUniqueSlug(baseSlug, existingSlugs);
                    // Only update LOCAL state if the slug is actually different
                    if (uniqueSlug !== localNodeData.slug) {
                        setLocalNodeData(prev => ({
                            ...prev,
                            slug: uniqueSlug
                        }));
                    }
                }
            }
        }
    }, [localNodeData.label, selectedNodeId, graph, slugManuallyEdited]);
    useEffect(() => {
        if (selectedEdgeId && graph) {
            // Only reload if we're switching to a different edge
            if (lastLoadedEdgeRef.current !== selectedEdgeId) {
                const edge = graph.edges.find((e) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                if (edge) {
                    setLocalEdgeData({
                        slug: edge.slug || '',
                        probability: edge.p?.mean || 0,
                        stdev: edge.p?.stdev || 0,
                        locked: edge.p?.locked || false,
                        description: edge.description || '',
                        costs: edge.costs || {},
                        weight_default: edge.weight_default || 0,
                    });
                    lastLoadedEdgeRef.current = selectedEdgeId;
                }
            }
        }
        else if (!selectedEdgeId) {
            // Clear the ref when no edge is selected
            lastLoadedEdgeRef.current = null;
        }
    }, [selectedEdgeId, graph]);
    // Handle keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            // Don't handle shortcuts when user is typing in form fields
            const target = e.target;
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
                return;
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedEdgeId && activeTab === 'edge') {
                    e.preventDefault();
                    if (confirm('Delete this edge?')) {
                        const next = structuredClone(graph);
                        if (next) {
                            next.edges = next.edges.filter((e) => e.id !== selectedEdgeId && `${e.from}->${e.to}` !== selectedEdgeId);
                            setGraph(next);
                            onSelectedEdgeChange(null);
                        }
                    }
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [selectedEdgeId, activeTab, graph, setGraph, onSelectedEdgeChange]);
    const updateGraph = useCallback((path, value) => {
        if (!graph)
            return;
        const next = structuredClone(graph);
        let cur = next;
        for (let i = 0; i < path.length - 1; i++) {
            cur = cur[path[i]];
        }
        cur[path[path.length - 1]] = value;
        if (next.metadata) {
            next.metadata.updated_at = new Date().toISOString();
        }
        setGraph(next);
    }, [graph, setGraph]);
    const updateNode = useCallback((field, value) => {
        if (!graph || !selectedNodeId)
            return;
        const next = structuredClone(graph);
        const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
        if (nodeIndex >= 0) {
            next.nodes[nodeIndex][field] = value;
            if (next.metadata) {
                next.metadata.updated_at = new Date().toISOString();
            }
            setGraph(next);
        }
    }, [selectedNodeId, graph, setGraph]);
    const updateEdge = useCallback((field, value) => {
        if (!graph || !selectedEdgeId)
            return;
        const next = structuredClone(graph);
        const edgeIndex = next.edges.findIndex((e) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
        if (edgeIndex >= 0) {
            if (field === 'probability') {
                next.edges[edgeIndex].p = { ...next.edges[edgeIndex].p, mean: value };
            }
            else if (field === 'stdev') {
                if (value === undefined) {
                    // Remove stdev property if undefined
                    const { stdev, ...pWithoutStdev } = next.edges[edgeIndex].p || {};
                    next.edges[edgeIndex].p = pWithoutStdev;
                }
                else {
                    next.edges[edgeIndex].p = { ...next.edges[edgeIndex].p, stdev: value };
                }
            }
            else if (field === 'locked') {
                next.edges[edgeIndex].p = { ...next.edges[edgeIndex].p, locked: value };
            }
            else if (field.startsWith('costs.')) {
                const costField = field.split('.')[1];
                if (!next.edges[edgeIndex].costs)
                    next.edges[edgeIndex].costs = {};
                next.edges[edgeIndex].costs[costField] = value;
            }
            else {
                next.edges[edgeIndex][field] = value;
            }
            if (next.metadata) {
                next.metadata.updated_at = new Date().toISOString();
            }
            setGraph(next);
        }
    }, [selectedEdgeId, graph, setGraph]);
    // JSON edit functions
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
            closeJsonEdit();
        }
        catch (error) {
            setJsonEditError(error instanceof Error ? error.message : 'Invalid JSON');
        }
    }, [jsonEditContent, setGraph, closeJsonEdit]);
    if (!graph)
        return null;
    // Add null checks to prevent crashes when nodes/edges are deleted
    const selectedNode = selectedNodeId && graph.nodes ? graph.nodes.find((n) => n.id === selectedNodeId) : null;
    const selectedEdge = selectedEdgeId && graph.edges ? graph.edges.find((e) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId) : null;
    return (_jsxs("div", { style: {
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
            borderLeft: '1px solid #e9ecef',
            width: '350px',
            minWidth: '350px',
            maxWidth: '350px',
            boxSizing: 'border-box'
        }, children: [_jsx("div", { style: { padding: '16px', borderBottom: '1px solid #e9ecef', background: '#f8f9fa' }, children: _jsx("h3", { style: { margin: 0, fontSize: '18px' }, children: "Properties" }) }), _jsx("div", { style: { display: 'flex', borderBottom: '1px solid #e9ecef', background: '#f8f9fa' }, children: ['graph', 'node', 'edge', 'json'].map((tab) => (_jsx("button", { onClick: () => setActiveTab(tab), style: {
                        flex: 1,
                        padding: '12px',
                        border: 'none',
                        background: activeTab === tab ? '#fff' : 'transparent',
                        borderBottom: activeTab === tab ? '2px solid #007bff' : '2px solid transparent',
                        cursor: 'pointer',
                        textTransform: 'capitalize',
                        fontSize: '12px',
                    }, children: tab }, tab))) }), _jsxs("div", { style: {
                    flex: 1,
                    padding: '12px',
                    overflow: 'auto',
                    boxSizing: 'border-box',
                    width: '100%'
                }, children: [activeTab === 'graph' && (_jsxs("div", { children: [_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Description" }), _jsx("textarea", { value: graph.metadata?.description || '', onChange: (e) => updateGraph(['metadata', 'description'], e.target.value), placeholder: "Enter graph description...", style: {
                                            width: '100%',
                                            padding: '8px',
                                            border: '1px solid #ddd',
                                            borderRadius: '4px',
                                            boxSizing: 'border-box',
                                            minHeight: '60px',
                                            resize: 'vertical'
                                        } })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Version" }), _jsx("input", { value: graph.metadata?.version || '', onChange: (e) => updateGraph(['metadata', 'version'], e.target.value), placeholder: "1.0.0", style: {
                                            width: '100%',
                                            padding: '8px',
                                            border: '1px solid #ddd',
                                            borderRadius: '4px',
                                            boxSizing: 'border-box'
                                        } })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Author" }), _jsx("input", { value: graph.metadata?.author || '', onChange: (e) => updateGraph(['metadata', 'author'], e.target.value), placeholder: "Your name", style: {
                                            width: '100%',
                                            padding: '8px',
                                            border: '1px solid #ddd',
                                            borderRadius: '4px',
                                            boxSizing: 'border-box'
                                        } })] })] })), activeTab === 'node' && (_jsx("div", { children: selectedNode ? (_jsxs("div", { children: [_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Label" }), _jsx("input", { "data-field": "label", value: localNodeData.label || '', onChange: (e) => setLocalNodeData({ ...localNodeData, label: e.target.value }), onBlur: () => {
                                                // Update both label and slug in a single graph update to avoid race conditions
                                                if (!graph || !selectedNodeId)
                                                    return;
                                                const next = structuredClone(graph);
                                                const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                if (nodeIndex >= 0) {
                                                    next.nodes[nodeIndex].label = localNodeData.label;
                                                    // Also update slug if it was auto-generated (ONLY on first commit)
                                                    if (!slugManuallyEdited && localNodeData.slug && !hasLabelBeenCommittedRef.current[selectedNodeId]) {
                                                        next.nodes[nodeIndex].slug = localNodeData.slug;
                                                    }
                                                    // Mark this node's label as committed (slug is now immutable)
                                                    hasLabelBeenCommittedRef.current[selectedNodeId] = true;
                                                    if (next.metadata) {
                                                        next.metadata.updated_at = new Date().toISOString();
                                                    }
                                                    setGraph(next);
                                                }
                                            }, onKeyDown: (e) => {
                                                if (e.key === 'Enter') {
                                                    // Update both label and slug in a single graph update to avoid race conditions
                                                    if (!graph || !selectedNodeId)
                                                        return;
                                                    const next = structuredClone(graph);
                                                    const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                    if (nodeIndex >= 0) {
                                                        next.nodes[nodeIndex].label = localNodeData.label;
                                                        // Also update slug if it was auto-generated (ONLY on first commit)
                                                        if (!slugManuallyEdited && localNodeData.slug && !hasLabelBeenCommittedRef.current[selectedNodeId]) {
                                                            next.nodes[nodeIndex].slug = localNodeData.slug;
                                                        }
                                                        // Mark this node's label as committed (slug is now immutable)
                                                        hasLabelBeenCommittedRef.current[selectedNodeId] = true;
                                                        if (next.metadata) {
                                                            next.metadata.updated_at = new Date().toISOString();
                                                        }
                                                        setGraph(next);
                                                    }
                                                }
                                            }, style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Node Type" }), _jsxs("div", { style: { display: 'flex', gap: '8px' }, children: [_jsx("button", { type: "button", onClick: () => {
                                                        setNodeType('normal');
                                                        // Clear case data when switching to normal
                                                        setCaseData({
                                                            id: '',
                                                            parameter_id: '',
                                                            status: 'active',
                                                            variants: []
                                                        });
                                                        setCaseMode('manual');
                                                        // Update graph
                                                        if (graph && selectedNodeId) {
                                                            const next = structuredClone(graph);
                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                            if (nodeIndex >= 0) {
                                                                delete next.nodes[nodeIndex].type;
                                                                delete next.nodes[nodeIndex].case;
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                setGraph(next);
                                                            }
                                                        }
                                                    }, style: {
                                                        padding: '8px 16px',
                                                        border: '1px solid #ddd',
                                                        borderRadius: '4px',
                                                        background: nodeType === 'normal' ? '#007bff' : '#fff',
                                                        color: nodeType === 'normal' ? '#fff' : '#333',
                                                        cursor: 'pointer',
                                                        fontSize: '12px',
                                                        fontWeight: '600'
                                                    }, children: "Normal" }), _jsx("button", { type: "button", onClick: () => {
                                                        setNodeType('case');
                                                        // Initialize case data if empty
                                                        const newCaseData = caseData.variants.length === 0 ? {
                                                            id: `case_${Date.now()}`,
                                                            parameter_id: '',
                                                            status: 'active',
                                                            variants: [
                                                                { name: 'control', weight: 0.5, description: 'Control variant' },
                                                                { name: 'treatment', weight: 0.5, description: 'Treatment variant' }
                                                            ]
                                                        } : caseData;
                                                        setCaseData(newCaseData);
                                                        // Update graph
                                                        if (graph && selectedNodeId) {
                                                            const next = structuredClone(graph);
                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                            if (nodeIndex >= 0) {
                                                                console.log('Converting node to case:', selectedNodeId, newCaseData);
                                                                next.nodes[nodeIndex].type = 'case';
                                                                next.nodes[nodeIndex].case = {
                                                                    id: newCaseData.id,
                                                                    parameter_id: newCaseData.parameter_id,
                                                                    status: newCaseData.status,
                                                                    variants: newCaseData.variants
                                                                };
                                                                // Auto-assign a fresh color from the palette
                                                                if (!next.nodes[nodeIndex].layout) {
                                                                    next.nodes[nodeIndex].layout = {};
                                                                }
                                                                if (!next.nodes[nodeIndex].layout.color) {
                                                                    next.nodes[nodeIndex].layout.color = getNextAvailableColor(graph);
                                                                }
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                console.log('Updated node:', next.nodes[nodeIndex]);
                                                                setGraph(next);
                                                            }
                                                        }
                                                    }, style: {
                                                        padding: '8px 16px',
                                                        border: '1px solid #ddd',
                                                        borderRadius: '4px',
                                                        background: nodeType === 'case' ? '#8B5CF6' : '#fff',
                                                        color: nodeType === 'case' ? '#fff' : '#333',
                                                        cursor: 'pointer',
                                                        fontSize: '12px',
                                                        fontWeight: '600'
                                                    }, children: "Case" })] })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Slug" }), _jsx("input", { "data-field": "slug", value: localNodeData.slug || '', onChange: (e) => {
                                                setLocalNodeData({ ...localNodeData, slug: e.target.value });
                                                setSlugManuallyEdited(true); // Mark as manually edited
                                            }, onBlur: () => updateNode('slug', localNodeData.slug), onKeyDown: (e) => e.key === 'Enter' && updateNode('slug', localNodeData.slug), style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } })] }), _jsx("div", { style: { marginBottom: '20px' }, children: _jsxs("label", { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }, children: [_jsx("input", { type: "checkbox", checked: localNodeData.absorbing || false, onChange: (e) => {
                                                    const newValue = e.target.checked;
                                                    setLocalNodeData({ ...localNodeData, absorbing: newValue });
                                                    updateNode('absorbing', newValue);
                                                } }), _jsx("span", { children: "Terminal Node" })] }) }), _jsx("div", { style: { marginBottom: '20px' }, children: _jsxs("label", { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }, children: [_jsx("input", { type: "checkbox", checked: Boolean(selectedNode.entry?.is_start), onChange: (e) => {
                                                    const next = structuredClone(graph);
                                                    const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                    if (nodeIndex >= 0) {
                                                        next.nodes[nodeIndex].entry = {
                                                            ...(next.nodes[nodeIndex].entry || {}),
                                                            is_start: e.target.checked,
                                                        };
                                                        if (next.metadata) {
                                                            next.metadata.updated_at = new Date().toISOString();
                                                        }
                                                        setGraph(next);
                                                    }
                                                } }), _jsx("span", { children: "Start Node" })] }) }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Entry Weight" }), _jsx("input", { type: "number", min: "0", step: "0.1", value: selectedNode.entry?.entry_weight ?? '', onChange: (e) => {
                                                const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                                                const next = structuredClone(graph);
                                                const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                if (nodeIndex >= 0) {
                                                    next.nodes[nodeIndex].entry = {
                                                        ...(next.nodes[nodeIndex].entry || {}),
                                                        entry_weight: val,
                                                    };
                                                    if (next.metadata) {
                                                        next.metadata.updated_at = new Date().toISOString();
                                                    }
                                                    setGraph(next);
                                                }
                                            }, placeholder: "e.g. 1.0", style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Outcome Type" }), _jsxs("select", { value: localNodeData.outcome_type || '', onChange: (e) => {
                                                const newValue = e.target.value === '' ? undefined : e.target.value;
                                                setLocalNodeData({ ...localNodeData, outcome_type: newValue });
                                                updateNode('outcome_type', newValue);
                                            }, style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            }, children: [_jsx("option", { value: "", children: "None" }), _jsx("option", { value: "success", children: "Success" }), _jsx("option", { value: "failure", children: "Failure" }), _jsx("option", { value: "error", children: "Error" }), _jsx("option", { value: "neutral", children: "Neutral" }), _jsx("option", { value: "other", children: "Other" })] })] }), nodeType === 'case' && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Mode" }), _jsxs("div", { style: { display: 'flex', gap: '8px' }, children: [_jsx("button", { type: "button", onClick: () => setCaseMode('manual'), style: {
                                                                padding: '8px 16px',
                                                                border: '1px solid #ddd',
                                                                borderRadius: '4px',
                                                                background: caseMode === 'manual' ? '#007bff' : '#fff',
                                                                color: caseMode === 'manual' ? '#fff' : '#333',
                                                                cursor: 'pointer',
                                                                fontSize: '12px',
                                                                fontWeight: '600'
                                                            }, children: "Manual" }), _jsx("button", { type: "button", onClick: () => setCaseMode('registry'), style: {
                                                                padding: '8px 16px',
                                                                border: '1px solid #ddd',
                                                                borderRadius: '4px',
                                                                background: caseMode === 'registry' ? '#007bff' : '#fff',
                                                                color: caseMode === 'registry' ? '#fff' : '#333',
                                                                cursor: 'pointer',
                                                                fontSize: '12px',
                                                                fontWeight: '600'
                                                            }, children: "Registry" })] })] }), caseData.variants.length > 0 && (() => {
                                            const currentNodeColor = graph?.nodes.find((n) => n.id === selectedNodeId)?.layout?.color || '#e5e7eb';
                                            return (_jsxs("div", { style: { marginBottom: '20px', padding: '12px', background: '#f0f7ff', borderRadius: '4px', border: `2px solid ${currentNodeColor}` }, children: [_jsxs("label", { style: {
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '8px',
                                                            marginBottom: '8px',
                                                            fontWeight: '600',
                                                            fontSize: '12px',
                                                            color: '#0066cc'
                                                        }, children: [_jsx("div", { style: {
                                                                    width: '16px',
                                                                    height: '16px',
                                                                    borderRadius: '2px',
                                                                    background: currentNodeColor,
                                                                    border: '1px solid rgba(0,0,0,0.2)',
                                                                    flexShrink: 0
                                                                } }), "Quick View Variants (What-If Analysis)"] }), _jsxs("select", { value: whatIfAnalysis?.caseNodeId === selectedNodeId ? whatIfAnalysis.selectedVariant : "", onChange: (e) => {
                                                            const variantName = e.target.value;
                                                            if (variantName && selectedNodeId) {
                                                                setWhatIfAnalysis({
                                                                    caseNodeId: selectedNodeId,
                                                                    selectedVariant: variantName
                                                                });
                                                            }
                                                            else {
                                                                setWhatIfAnalysis(null);
                                                            }
                                                        }, style: {
                                                            width: '100%',
                                                            padding: '8px',
                                                            border: whatIfAnalysis?.caseNodeId === selectedNodeId ? '2px solid #0066cc' : '1px solid #c4e0ff',
                                                            borderRadius: '4px',
                                                            boxSizing: 'border-box',
                                                            fontSize: '12px',
                                                            background: whatIfAnalysis?.caseNodeId === selectedNodeId ? '#fff9e6' : 'white',
                                                            fontWeight: whatIfAnalysis?.caseNodeId === selectedNodeId ? 'bold' : 'normal'
                                                        }, children: [_jsx("option", { value: "", children: "All variants (actual weights)" }), caseData.variants.map((v, i) => (_jsxs("option", { value: v.name, children: [v.name, " - What if 100%?"] }, i)))] }), whatIfAnalysis?.caseNodeId === selectedNodeId && (_jsxs("div", { style: {
                                                            marginTop: '8px',
                                                            padding: '6px 8px',
                                                            background: '#fff9e6',
                                                            border: '1px solid #ffd700',
                                                            borderRadius: '3px',
                                                            fontSize: '11px',
                                                            color: '#997400',
                                                            fontWeight: 'bold'
                                                        }, children: ["\uD83D\uDD2C WHAT-IF MODE: ", whatIfAnalysis.selectedVariant, " @ 100%"] }))] }));
                                        })(), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: caseMode === 'registry' ? 'Parameter ID' : 'Case ID' }), caseMode === 'registry' ? (_jsxs("div", { children: [_jsxs("select", { value: caseData.parameter_id, onChange: (e) => {
                                                                const newParameterId = e.target.value;
                                                                setCaseData({ ...caseData, parameter_id: newParameterId });
                                                                // TODO: Load parameter from registry
                                                                if (newParameterId) {
                                                                    // Simulate loading parameter data
                                                                    setCaseData({
                                                                        ...caseData,
                                                                        parameter_id: newParameterId,
                                                                        id: 'case_001',
                                                                        status: 'active',
                                                                        variants: [
                                                                            { name: 'control', weight: 0.5, description: 'Control variant' },
                                                                            { name: 'treatment', weight: 0.5, description: 'Treatment variant' }
                                                                        ]
                                                                    });
                                                                }
                                                            }, style: {
                                                                width: '100%',
                                                                padding: '8px',
                                                                border: '1px solid #ddd',
                                                                borderRadius: '4px',
                                                                boxSizing: 'border-box'
                                                            }, children: [_jsx("option", { value: "", children: "Select parameter..." }), _jsx("option", { value: "case-checkout-flow-001", children: "Checkout Flow Test" }), _jsx("option", { value: "case-pricing-test-001", children: "Pricing Strategy Test" }), _jsx("option", { value: "case-onboarding-test-001", children: "Onboarding Flow Test" })] }), caseData.parameter_id && (_jsxs("div", { style: {
                                                                marginTop: '8px',
                                                                padding: '8px',
                                                                background: '#f8f9fa',
                                                                borderRadius: '4px',
                                                                fontSize: '12px'
                                                            }, children: [_jsx("div", { style: { fontWeight: '600', marginBottom: '4px' }, children: "Registry Info" }), _jsx("div", { children: "Name: Checkout Flow A/B Test" }), _jsx("div", { children: "Status: \u25CF Active" }), _jsx("div", { children: "Platform: Statsig" }), _jsx("div", { children: "Last Updated: 2025-01-20" }), _jsxs("div", { style: { marginTop: '8px' }, children: [_jsx("button", { type: "button", onClick: () => {
                                                                                // TODO: Refresh from registry
                                                                                console.log('Refresh from registry');
                                                                            }, style: {
                                                                                background: '#007bff',
                                                                                color: 'white',
                                                                                border: 'none',
                                                                                borderRadius: '3px',
                                                                                padding: '4px 8px',
                                                                                cursor: 'pointer',
                                                                                fontSize: '10px',
                                                                                marginRight: '8px'
                                                                            }, children: "\u21BB Refresh" }), _jsx("button", { type: "button", onClick: () => {
                                                                                // TODO: Edit in registry
                                                                                console.log('Edit in registry');
                                                                            }, style: {
                                                                                background: '#28a745',
                                                                                color: 'white',
                                                                                border: 'none',
                                                                                borderRadius: '3px',
                                                                                padding: '4px 8px',
                                                                                cursor: 'pointer',
                                                                                fontSize: '10px'
                                                                            }, children: "\uD83D\uDCDD Edit" })] }), _jsx("div", { style: { marginTop: '8px' }, children: _jsx("button", { type: "button", onClick: () => {
                                                                            setCaseMode('manual');
                                                                            // Clear parameter_id when switching to manual
                                                                            setCaseData({ ...caseData, parameter_id: '' });
                                                                        }, style: {
                                                                            background: '#6c757d',
                                                                            color: 'white',
                                                                            border: 'none',
                                                                            borderRadius: '3px',
                                                                            padding: '4px 8px',
                                                                            cursor: 'pointer',
                                                                            fontSize: '10px'
                                                                        }, children: "Override Locally" }) })] }))] })) : (_jsx("input", { value: caseData.id, onChange: (e) => setCaseData({ ...caseData, id: e.target.value }), onBlur: () => {
                                                        if (graph && selectedNodeId) {
                                                            const next = structuredClone(graph);
                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                                                next.nodes[nodeIndex].case.id = caseData.id;
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                setGraph(next);
                                                            }
                                                        }
                                                    }, placeholder: "case_001", style: {
                                                        width: '100%',
                                                        padding: '8px',
                                                        border: '1px solid #ddd',
                                                        borderRadius: '4px',
                                                        boxSizing: 'border-box'
                                                    } }))] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Status" }), _jsxs("select", { value: caseData.status, onChange: (e) => {
                                                        const newStatus = e.target.value;
                                                        setCaseData({ ...caseData, status: newStatus });
                                                        if (graph && selectedNodeId) {
                                                            const next = structuredClone(graph);
                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                                                next.nodes[nodeIndex].case.status = newStatus;
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                setGraph(next);
                                                            }
                                                        }
                                                    }, style: {
                                                        width: '100%',
                                                        padding: '8px',
                                                        border: '1px solid #ddd',
                                                        borderRadius: '4px',
                                                        boxSizing: 'border-box'
                                                    }, children: [_jsx("option", { value: "active", children: "Active" }), _jsx("option", { value: "paused", children: "Paused" }), _jsx("option", { value: "completed", children: "Completed" })] })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Node Color" }), _jsx("div", { style: { fontSize: '11px', color: '#666', marginBottom: '8px' }, children: "Colors are auto-assigned from the palette. Customize:" }), _jsx("input", { type: "color", value: (() => {
                                                        const node = graph?.nodes.find((n) => n.id === selectedNodeId);
                                                        return node?.layout?.color || '#4ade80'; // Default to first palette color if none assigned
                                                    })(), onChange: (e) => {
                                                        e.stopPropagation();
                                                        if (graph && selectedNodeId) {
                                                            const next = structuredClone(graph);
                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                            if (nodeIndex >= 0) {
                                                                if (!next.nodes[nodeIndex].layout) {
                                                                    next.nodes[nodeIndex].layout = {};
                                                                }
                                                                next.nodes[nodeIndex].layout.color = e.target.value;
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                setGraph(next);
                                                            }
                                                        }
                                                    }, onInput: (e) => {
                                                        e.stopPropagation();
                                                        const target = e.target;
                                                        if (graph && selectedNodeId) {
                                                            const next = structuredClone(graph);
                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                            if (nodeIndex >= 0) {
                                                                if (!next.nodes[nodeIndex].layout) {
                                                                    next.nodes[nodeIndex].layout = {};
                                                                }
                                                                next.nodes[nodeIndex].layout.color = target.value;
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                setGraph(next);
                                                            }
                                                        }
                                                    }, style: {
                                                        width: '60px',
                                                        height: '32px',
                                                        border: '1px solid #ddd',
                                                        borderRadius: '4px',
                                                        cursor: 'pointer'
                                                    } }), (() => {
                                                    const node = graph?.nodes.find((n) => n.id === selectedNodeId);
                                                    return node?.layout?.color && (_jsx("button", { onClick: () => {
                                                            if (graph && selectedNodeId) {
                                                                const next = structuredClone(graph);
                                                                const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                                if (nodeIndex >= 0 && next.nodes[nodeIndex].layout) {
                                                                    // Remove color to trigger auto-assignment
                                                                    delete next.nodes[nodeIndex].layout.color;
                                                                    if (next.metadata) {
                                                                        next.metadata.updated_at = new Date().toISOString();
                                                                    }
                                                                    setGraph(next);
                                                                }
                                                            }
                                                        }, style: {
                                                            marginLeft: '8px',
                                                            padding: '6px 12px',
                                                            fontSize: '11px',
                                                            background: '#f1f1f1',
                                                            border: '1px solid #ddd',
                                                            borderRadius: '4px',
                                                            cursor: 'pointer'
                                                        }, children: "Reset to Auto" }));
                                                })()] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Variants" }), caseData.variants.map((variant, index) => (_jsxs("div", { style: {
                                                        marginBottom: '12px',
                                                        padding: '12px',
                                                        border: '1px solid #ddd',
                                                        borderRadius: '4px',
                                                        background: '#f9f9f9'
                                                    }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }, children: [_jsxs("span", { style: { fontWeight: '600', fontSize: '12px' }, children: ["Variant ", index + 1] }), _jsx("button", { type: "button", onClick: () => {
                                                                        const newVariants = caseData.variants.filter((_, i) => i !== index);
                                                                        setCaseData({ ...caseData, variants: newVariants });
                                                                        if (graph && selectedNodeId) {
                                                                            const next = structuredClone(graph);
                                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                                                                next.nodes[nodeIndex].case.variants = newVariants;
                                                                                if (next.metadata) {
                                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                                }
                                                                                setGraph(next);
                                                                            }
                                                                        }
                                                                    }, style: {
                                                                        background: '#dc3545',
                                                                        color: 'white',
                                                                        border: 'none',
                                                                        borderRadius: '3px',
                                                                        padding: '4px 8px',
                                                                        cursor: 'pointer',
                                                                        fontSize: '10px'
                                                                    }, children: "\u2715 Remove" })] }), _jsxs("div", { style: { marginBottom: '8px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }, children: "Name" }), _jsx("input", { value: variant.name, onChange: (e) => {
                                                                        const newVariants = [...caseData.variants];
                                                                        newVariants[index].name = e.target.value;
                                                                        setCaseData({ ...caseData, variants: newVariants });
                                                                    }, onBlur: () => {
                                                                        if (graph && selectedNodeId) {
                                                                            const next = structuredClone(graph);
                                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                                                                next.nodes[nodeIndex].case.variants = caseData.variants;
                                                                                if (next.metadata) {
                                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                                }
                                                                                setGraph(next);
                                                                            }
                                                                        }
                                                                    }, placeholder: "control", style: {
                                                                        width: '100%',
                                                                        padding: '6px',
                                                                        border: '1px solid #ddd',
                                                                        borderRadius: '3px',
                                                                        boxSizing: 'border-box',
                                                                        fontSize: '12px'
                                                                    } })] }), _jsxs("div", { style: { marginBottom: '8px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }, children: "Weight (0-1)" }), _jsx("input", { type: "number", min: "0", max: "1", step: "0.01", value: variant.weight, onChange: (e) => {
                                                                        const newVariants = [...caseData.variants];
                                                                        newVariants[index].weight = parseFloat(e.target.value) || 0;
                                                                        setCaseData({ ...caseData, variants: newVariants });
                                                                    }, onBlur: () => {
                                                                        if (graph && selectedNodeId) {
                                                                            const next = structuredClone(graph);
                                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                                                                next.nodes[nodeIndex].case.variants = caseData.variants;
                                                                                if (next.metadata) {
                                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                                }
                                                                                setGraph(next);
                                                                            }
                                                                        }
                                                                    }, placeholder: "0.5", style: {
                                                                        width: '100%',
                                                                        padding: '6px',
                                                                        border: '1px solid #ddd',
                                                                        borderRadius: '3px',
                                                                        boxSizing: 'border-box',
                                                                        fontSize: '12px'
                                                                    } })] }), _jsxs("div", { children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }, children: "Description" }), _jsx("input", { value: variant.description || '', onChange: (e) => {
                                                                        const newVariants = [...caseData.variants];
                                                                        newVariants[index].description = e.target.value;
                                                                        setCaseData({ ...caseData, variants: newVariants });
                                                                    }, onBlur: () => {
                                                                        if (graph && selectedNodeId) {
                                                                            const next = structuredClone(graph);
                                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                                                                next.nodes[nodeIndex].case.variants = caseData.variants;
                                                                                if (next.metadata) {
                                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                                }
                                                                                setGraph(next);
                                                                            }
                                                                        }
                                                                    }, placeholder: "Original flow", style: {
                                                                        width: '100%',
                                                                        padding: '6px',
                                                                        border: '1px solid #ddd',
                                                                        borderRadius: '3px',
                                                                        boxSizing: 'border-box',
                                                                        fontSize: '12px'
                                                                    } })] })] }, index))), _jsx("button", { type: "button", onClick: () => {
                                                        const newVariants = [...caseData.variants, { name: `variant_${caseData.variants.length + 1}`, weight: 0.1, description: '' }];
                                                        setCaseData({ ...caseData, variants: newVariants });
                                                        if (graph && selectedNodeId) {
                                                            const next = structuredClone(graph);
                                                            const nodeIndex = next.nodes.findIndex((n) => n.id === selectedNodeId);
                                                            if (nodeIndex >= 0 && next.nodes[nodeIndex].case) {
                                                                next.nodes[nodeIndex].case.variants = newVariants;
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                setGraph(next);
                                                            }
                                                        }
                                                    }, style: {
                                                        background: '#28a745',
                                                        color: 'white',
                                                        border: 'none',
                                                        borderRadius: '4px',
                                                        padding: '8px 16px',
                                                        cursor: 'pointer',
                                                        fontSize: '12px',
                                                        fontWeight: '600',
                                                        width: '100%'
                                                    }, children: "+ Add Variant" }), _jsxs("div", { style: {
                                                        marginTop: '8px',
                                                        padding: '8px',
                                                        background: '#f8f9fa',
                                                        borderRadius: '4px',
                                                        fontSize: '12px',
                                                        textAlign: 'center'
                                                    }, children: ["Total Weight: ", caseData.variants.reduce((sum, v) => sum + v.weight, 0).toFixed(1), Math.abs(caseData.variants.reduce((sum, v) => sum + v.weight, 0) - 1.0) < 0.001 ? ' ✓' : ' ⚠️'] })] })] })), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Tags" }), _jsx("input", { value: localNodeData.tags?.join(', ') || '', onChange: (e) => setLocalNodeData({
                                                ...localNodeData,
                                                tags: e.target.value.split(',').map(t => t.trim()).filter(t => t)
                                            }), onBlur: () => updateNode('tags', localNodeData.tags), placeholder: "tag1, tag2, tag3", style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Description" }), _jsx("textarea", { "data-field": "description", value: localNodeData.description || '', onChange: (e) => setLocalNodeData({ ...localNodeData, description: e.target.value }), onBlur: () => updateNode('description', localNodeData.description), style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                minHeight: '60px',
                                                boxSizing: 'border-box'
                                            } })] })] })) : (_jsx("div", { style: { textAlign: 'center', color: '#666', padding: '20px' }, children: "No node selected" })) })), activeTab === 'edge' && (_jsx("div", { children: selectedEdge ? (_jsxs("div", { children: [_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Slug" }), _jsx("input", { "data-field": "slug", value: localEdgeData.slug || '', onChange: (e) => setLocalEdgeData({ ...localEdgeData, slug: e.target.value }), onBlur: () => updateEdge('slug', localEdgeData.slug), onKeyDown: (e) => e.key === 'Enter' && updateEdge('slug', localEdgeData.slug), placeholder: "edge-slug", style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant)
                                                ? 'Sub-Route Probability (within variant)'
                                                : 'Probability' }), _jsx("input", { "data-field": "probability", type: "text", value: localEdgeData.probability || 0, onChange: (e) => {
                                                const value = e.target.value;
                                                setLocalEdgeData({ ...localEdgeData, probability: value });
                                            }, onBlur: () => {
                                                const numValue = parseFloat(localEdgeData.probability) || 0;
                                                setLocalEdgeData({ ...localEdgeData, probability: numValue });
                                                updateEdge('probability', numValue);
                                            }, onKeyDown: (e) => {
                                                if (e.key === 'Enter') {
                                                    const numValue = parseFloat(localEdgeData.probability) || 0;
                                                    setLocalEdgeData({ ...localEdgeData, probability: numValue });
                                                    updateEdge('probability', numValue);
                                                    e.currentTarget.blur();
                                                }
                                            }, placeholder: selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) ? "1.0 (for single path)" : "0.0", style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } }), selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) && (_jsx("div", { style: { fontSize: '11px', color: '#666', marginTop: '4px' }, children: "For single-path variants, leave at 1.0. For multi-path variants, probabilities must sum to 1.0." }))] }), !(selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant)) && (_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Standard Deviation" }), _jsx("input", { "data-field": "stdev", type: "text", value: localEdgeData.stdev !== undefined ? localEdgeData.stdev : '', onChange: (e) => {
                                                const value = e.target.value;
                                                setLocalEdgeData({ ...localEdgeData, stdev: value });
                                            }, onBlur: () => {
                                                const numValue = parseFloat(localEdgeData.stdev);
                                                if (isNaN(numValue)) {
                                                    setLocalEdgeData({ ...localEdgeData, stdev: undefined });
                                                    updateEdge('stdev', undefined);
                                                }
                                                else {
                                                    setLocalEdgeData({ ...localEdgeData, stdev: numValue });
                                                    updateEdge('stdev', numValue);
                                                }
                                            }, onKeyDown: (e) => {
                                                if (e.key === 'Enter') {
                                                    const numValue = parseFloat(localEdgeData.stdev);
                                                    if (isNaN(numValue)) {
                                                        setLocalEdgeData({ ...localEdgeData, stdev: undefined });
                                                        updateEdge('stdev', undefined);
                                                    }
                                                    else {
                                                        setLocalEdgeData({ ...localEdgeData, stdev: numValue });
                                                        updateEdge('stdev', numValue);
                                                    }
                                                    e.currentTarget.blur();
                                                }
                                            }, placeholder: "Optional", style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } })] })), _jsx("div", { style: { marginBottom: '20px' }, children: _jsxs("label", { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }, children: [_jsx("input", { type: "checkbox", checked: localEdgeData.locked || false, onChange: (e) => {
                                                    const newValue = e.target.checked;
                                                    setLocalEdgeData({ ...localEdgeData, locked: newValue });
                                                    updateEdge('locked', newValue);
                                                } }), _jsx("span", { children: "Locked Probability" })] }) }), selectedEdge && graph && (_jsx(ConditionalProbabilitiesSection, { edge: selectedEdge, graph: graph, setGraph: setGraph, localConditionalP: localConditionalP, setLocalConditionalP: setLocalConditionalP, onLocalUpdate: (conditionalP) => {
                                        // Update local state immediately (like variants)
                                        setLocalConditionalP(conditionalP);
                                        // Also update graph
                                        if (graph && selectedEdgeId) {
                                            const nextGraph = structuredClone(graph);
                                            const edgeIndex = nextGraph.edges.findIndex((e) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                                            if (edgeIndex >= 0) {
                                                nextGraph.edges[edgeIndex].conditional_p = conditionalP.length > 0 ? conditionalP : undefined;
                                                if (!nextGraph.metadata)
                                                    nextGraph.metadata = {};
                                                nextGraph.metadata.updated_at = new Date().toISOString();
                                                setGraph(nextGraph);
                                            }
                                        }
                                    }, onUpdateColor: (color) => {
                                        const nextGraph = structuredClone(graph);
                                        const edgeIndex = nextGraph.edges.findIndex((e) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                                        if (edgeIndex >= 0) {
                                            if (!nextGraph.edges[edgeIndex].display) {
                                                nextGraph.edges[edgeIndex].display = {};
                                            }
                                            nextGraph.edges[edgeIndex].display.conditional_color = color;
                                            if (!nextGraph.metadata)
                                                nextGraph.metadata = {};
                                            nextGraph.metadata.updated_at = new Date().toISOString();
                                            setGraph(nextGraph);
                                        }
                                    } })), !(selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant)) && (_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Weight Default" }), _jsx("input", { type: "number", min: "0", step: "0.1", value: localEdgeData.weight_default || 0, onChange: (e) => setLocalEdgeData({ ...localEdgeData, weight_default: parseFloat(e.target.value) || 0 }), onBlur: () => updateEdge('weight_default', localEdgeData.weight_default), onKeyDown: (e) => e.key === 'Enter' && updateEdge('weight_default', localEdgeData.weight_default), placeholder: "For residual distribution", style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                boxSizing: 'border-box'
                                            } }), _jsx("div", { style: { fontSize: '11px', color: '#666', marginTop: '4px' }, children: "Used to distribute residual probability among unspecified edges from the same source" })] })), selectedEdge && (selectedEdge.case_id || selectedEdge.case_variant) && (() => {
                                    // Find the case node and get the variant weight
                                    const caseNode = graph.nodes.find((n) => n.case && n.case.id === selectedEdge.case_id);
                                    const variant = caseNode?.case?.variants?.find((v) => v.name === selectedEdge.case_variant);
                                    const variantWeight = variant?.weight || 0;
                                    const subRouteProbability = selectedEdge.p?.mean || 1.0;
                                    const effectiveProbability = variantWeight * subRouteProbability;
                                    return (_jsxs("div", { style: { marginBottom: '20px', padding: '12px', background: '#f8f9fa', borderRadius: '4px', border: '1px solid #e9ecef' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600', color: '#8B5CF6' }, children: "Case Edge Summary" }), _jsxs("div", { style: { marginBottom: '12px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', color: '#666' }, children: "Case ID" }), _jsx("input", { type: "text", value: selectedEdge.case_id || '', readOnly: true, style: {
                                                            width: '100%',
                                                            padding: '6px 8px',
                                                            border: '1px solid #ddd',
                                                            borderRadius: '3px',
                                                            background: '#f8f9fa',
                                                            fontSize: '12px',
                                                            color: '#666'
                                                        } })] }), _jsxs("div", { style: { marginBottom: '12px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', color: '#666' }, children: "Variant" }), _jsx("input", { type: "text", value: selectedEdge.case_variant || '', readOnly: true, style: {
                                                            width: '100%',
                                                            padding: '6px 8px',
                                                            border: '1px solid #ddd',
                                                            borderRadius: '3px',
                                                            background: '#f8f9fa',
                                                            fontSize: '12px',
                                                            color: '#666'
                                                        } })] }), _jsxs("div", { style: { marginBottom: '12px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', color: '#8B5CF6' }, children: "Variant Weight (Traffic Split)" }), _jsx("input", { type: "text", value: `${(variantWeight * 100).toFixed(1)}% (${variantWeight.toFixed(3)})`, readOnly: true, style: {
                                                            width: '100%',
                                                            padding: '6px 8px',
                                                            border: '1px solid #C4B5FD',
                                                            borderRadius: '3px',
                                                            background: '#F3F0FF',
                                                            fontSize: '12px',
                                                            color: '#8B5CF6',
                                                            fontWeight: '600'
                                                        } })] }), _jsxs("div", { style: { marginBottom: '12px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', color: '#666' }, children: "Sub-Route Probability" }), _jsx("input", { type: "text", value: `${(subRouteProbability * 100).toFixed(1)}% (${subRouteProbability.toFixed(3)})`, readOnly: true, style: {
                                                            width: '100%',
                                                            padding: '6px 8px',
                                                            border: '1px solid #ddd',
                                                            borderRadius: '3px',
                                                            background: '#f8f9fa',
                                                            fontSize: '12px',
                                                            color: '#666',
                                                            fontWeight: '600'
                                                        } })] }), _jsxs("div", { style: { marginBottom: '12px', padding: '8px', background: '#FFF9E6', borderRadius: '3px', border: '1px solid #FFE066' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', color: '#997400', fontWeight: '600' }, children: "Effective Probability (Variant \u00D7 Sub-Route)" }), _jsxs("div", { style: { fontSize: '14px', color: '#997400', fontWeight: '700' }, children: [(effectiveProbability * 100).toFixed(1), "% (", effectiveProbability.toFixed(3), ")"] })] }), _jsxs("div", { style: { fontSize: '11px', color: '#666' }, children: [_jsx("strong", { children: "Formula:" }), " Effective Probability = Variant Weight \u00D7 Sub-Route Probability", _jsx("br", {}), _jsx("strong", { children: "Example:" }), " If variant is 50% and sub-route is 50%, then 25% of total traffic flows through this edge."] })] }));
                                })(), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Costs" }), _jsxs("div", { style: {
                                                background: '#f8f9fa',
                                                padding: '12px',
                                                borderRadius: '4px',
                                                border: '1px solid #e9ecef',
                                                marginBottom: '12px'
                                            }, children: [_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: '12px' }, children: [_jsxs("div", { style: {
                                                                background: '#fff',
                                                                padding: '8px',
                                                                borderRadius: '3px',
                                                                border: '1px solid #e9ecef'
                                                            }, children: [_jsx("label", { style: { display: 'block', fontSize: '12px', marginBottom: '6px', color: '#495057', fontWeight: '600' }, children: "Monetary Cost (GBP)" }), _jsxs("div", { style: { display: 'flex', gap: '8px', alignItems: 'center' }, children: [_jsx("input", { type: "number", min: "0", step: "0.01", value: localEdgeData.costs?.monetary?.value || '', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    monetary: {
                                                                                        ...localEdgeData.costs?.monetary,
                                                                                        value: parseFloat(e.target.value) || undefined,
                                                                                        currency: localEdgeData.costs?.monetary?.currency || 'GBP'
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.monetary', localEdgeData.costs?.monetary), placeholder: "0.00", style: {
                                                                                flex: 1,
                                                                                padding: '6px 8px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '12px',
                                                                                boxSizing: 'border-box'
                                                                            } }), _jsxs("select", { value: localEdgeData.costs?.monetary?.currency || 'GBP', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    monetary: {
                                                                                        ...localEdgeData.costs?.monetary,
                                                                                        currency: e.target.value
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.monetary', localEdgeData.costs?.monetary), style: {
                                                                                padding: '6px 8px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '12px',
                                                                                background: 'white'
                                                                            }, children: [_jsx("option", { value: "GBP", children: "GBP" }), _jsx("option", { value: "USD", children: "USD" }), _jsx("option", { value: "EUR", children: "EUR" })] })] }), _jsxs("div", { style: { display: 'flex', gap: '8px', marginTop: '6px' }, children: [_jsx("input", { type: "number", min: "0", step: "0.01", value: localEdgeData.costs?.monetary?.stdev || '', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    monetary: {
                                                                                        ...localEdgeData.costs?.monetary,
                                                                                        stdev: parseFloat(e.target.value) || undefined
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.monetary', localEdgeData.costs?.monetary), placeholder: "Stdev (optional)", style: {
                                                                                flex: 1,
                                                                                padding: '4px 6px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '11px',
                                                                                boxSizing: 'border-box'
                                                                            } }), _jsxs("select", { value: localEdgeData.costs?.monetary?.distribution || 'normal', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    monetary: {
                                                                                        ...localEdgeData.costs?.monetary,
                                                                                        distribution: e.target.value
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.monetary', localEdgeData.costs?.monetary), style: {
                                                                                padding: '4px 6px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '11px',
                                                                                background: 'white'
                                                                            }, children: [_jsx("option", { value: "normal", children: "Normal" }), _jsx("option", { value: "lognormal", children: "Log-normal" }), _jsx("option", { value: "gamma", children: "Gamma" }), _jsx("option", { value: "uniform", children: "Uniform" })] })] })] }), _jsxs("div", { style: {
                                                                background: '#fff',
                                                                padding: '8px',
                                                                borderRadius: '3px',
                                                                border: '1px solid #e9ecef'
                                                            }, children: [_jsx("label", { style: { display: 'block', fontSize: '12px', marginBottom: '6px', color: '#495057', fontWeight: '600' }, children: "Time Cost (Days)" }), _jsxs("div", { style: { display: 'flex', gap: '8px', alignItems: 'center' }, children: [_jsx("input", { type: "number", min: "0", step: "0.1", value: localEdgeData.costs?.time?.value || '', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    time: {
                                                                                        ...localEdgeData.costs?.time,
                                                                                        value: parseFloat(e.target.value) || undefined,
                                                                                        units: localEdgeData.costs?.time?.units || 'days'
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.time', localEdgeData.costs?.time), placeholder: "0.0", style: {
                                                                                flex: 1,
                                                                                padding: '6px 8px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '12px',
                                                                                boxSizing: 'border-box'
                                                                            } }), _jsxs("select", { value: localEdgeData.costs?.time?.units || 'days', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    time: {
                                                                                        ...localEdgeData.costs?.time,
                                                                                        units: e.target.value
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.time', localEdgeData.costs?.time), style: {
                                                                                padding: '6px 8px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '12px',
                                                                                background: 'white'
                                                                            }, children: [_jsx("option", { value: "days", children: "Days" }), _jsx("option", { value: "hours", children: "Hours" }), _jsx("option", { value: "weeks", children: "Weeks" })] })] }), _jsxs("div", { style: { display: 'flex', gap: '8px', marginTop: '6px' }, children: [_jsx("input", { type: "number", min: "0", step: "0.1", value: localEdgeData.costs?.time?.stdev || '', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    time: {
                                                                                        ...localEdgeData.costs?.time,
                                                                                        stdev: parseFloat(e.target.value) || undefined
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.time', localEdgeData.costs?.time), placeholder: "Stdev (optional)", style: {
                                                                                flex: 1,
                                                                                padding: '4px 6px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '11px',
                                                                                boxSizing: 'border-box'
                                                                            } }), _jsxs("select", { value: localEdgeData.costs?.time?.distribution || 'lognormal', onChange: (e) => setLocalEdgeData({
                                                                                ...localEdgeData,
                                                                                costs: {
                                                                                    ...localEdgeData.costs,
                                                                                    time: {
                                                                                        ...localEdgeData.costs?.time,
                                                                                        distribution: e.target.value
                                                                                    }
                                                                                }
                                                                            }), onBlur: () => updateEdge('costs.time', localEdgeData.costs?.time), style: {
                                                                                padding: '4px 6px',
                                                                                border: '1px solid #ddd',
                                                                                borderRadius: '3px',
                                                                                fontSize: '11px',
                                                                                background: 'white'
                                                                            }, children: [_jsx("option", { value: "normal", children: "Normal" }), _jsx("option", { value: "lognormal", children: "Log-normal" }), _jsx("option", { value: "gamma", children: "Gamma" }), _jsx("option", { value: "uniform", children: "Uniform" })] })] })] })] }), (localEdgeData.costs?.monetary?.value || localEdgeData.costs?.time?.value) && (_jsx("div", { style: { marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #e9ecef' }, children: _jsx("button", { onClick: () => {
                                                            const clearedCosts = {};
                                                            setLocalEdgeData({
                                                                ...localEdgeData,
                                                                costs: clearedCosts
                                                            });
                                                            // Update the graph with cleared costs
                                                            if (!graph || !selectedEdgeId)
                                                                return;
                                                            const next = structuredClone(graph);
                                                            const edgeIndex = next.edges.findIndex((e) => e.id === selectedEdgeId || `${e.from}->${e.to}` === selectedEdgeId);
                                                            if (edgeIndex >= 0) {
                                                                next.edges[edgeIndex].costs = clearedCosts;
                                                                if (next.metadata) {
                                                                    next.metadata.updated_at = new Date().toISOString();
                                                                }
                                                                setGraph(next);
                                                            }
                                                        }, style: {
                                                            background: '#dc3545',
                                                            color: 'white',
                                                            border: 'none',
                                                            borderRadius: '3px',
                                                            padding: '4px 8px',
                                                            fontSize: '11px',
                                                            cursor: 'pointer'
                                                        }, children: "Clear All Costs" }) }))] })] }), _jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '8px', fontWeight: '600' }, children: "Description" }), _jsx("textarea", { "data-field": "description", value: localEdgeData.description || '', onChange: (e) => setLocalEdgeData({ ...localEdgeData, description: e.target.value }), onBlur: () => updateEdge('description', localEdgeData.description), style: {
                                                width: '100%',
                                                padding: '8px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                minHeight: '60px',
                                                boxSizing: 'border-box'
                                            } })] }), _jsx("button", { onClick: () => {
                                        if (confirm('Delete this edge?')) {
                                            const next = structuredClone(graph);
                                            next.edges = next.edges.filter((e) => e.id !== selectedEdgeId && `${e.from}->${e.to}` !== selectedEdgeId);
                                            setGraph(next);
                                            onSelectedEdgeChange(null);
                                        }
                                    }, style: {
                                        width: '100%',
                                        padding: '8px 16px',
                                        background: '#dc3545',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontSize: '14px',
                                        fontWeight: '500',
                                    }, children: "Delete Edge" })] })) : (_jsx("div", { style: { textAlign: 'center', color: '#666', padding: '20px' }, children: "No edge selected" })) })), activeTab === 'json' && (_jsxs("div", { children: [_jsxs("div", { style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: '12px'
                                }, children: [_jsx("div", { style: { fontSize: '12px', color: '#666' }, children: "Current graph JSON:" }), _jsx("button", { onClick: openJsonEdit, style: {
                                            background: '#007bff',
                                            color: 'white',
                                            border: 'none',
                                            borderRadius: '4px',
                                            padding: '6px 12px',
                                            fontSize: '12px',
                                            cursor: 'pointer'
                                        }, children: "Edit JSON" })] }), _jsx("pre", { style: {
                                    background: '#f8f9fa',
                                    padding: '12px',
                                    borderRadius: '4px',
                                    fontSize: '11px',
                                    overflow: 'auto',
                                    maxHeight: 'calc(100vh - 300px)',
                                    border: '1px solid #e9ecef',
                                    fontFamily: 'monospace',
                                    lineHeight: '1.5',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all'
                                }, children: JSON.stringify(graph, null, 2) })] }))] }), showJsonEdit && (_jsx("div", { style: {
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
                }, children: _jsxs("div", { style: {
                        background: 'white',
                        borderRadius: '8px',
                        padding: '20px',
                        width: '80%',
                        maxWidth: '800px',
                        maxHeight: '80vh',
                        display: 'flex',
                        flexDirection: 'column'
                    }, children: [_jsxs("div", { style: {
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                marginBottom: '16px'
                            }, children: [_jsx("h3", { style: { margin: 0, fontSize: '18px' }, children: "Edit Graph JSON" }), _jsx("button", { onClick: closeJsonEdit, style: {
                                        background: 'none',
                                        border: 'none',
                                        fontSize: '20px',
                                        cursor: 'pointer',
                                        color: '#666'
                                    }, children: "\u00D7" })] }), jsonEditError && (_jsxs("div", { style: {
                                background: '#f8d7da',
                                color: '#721c24',
                                padding: '8px 12px',
                                borderRadius: '4px',
                                marginBottom: '12px',
                                fontSize: '12px'
                            }, children: ["Error: ", jsonEditError] })), _jsx("textarea", { value: jsonEditContent, onChange: (e) => setJsonEditContent(e.target.value), style: {
                                flex: 1,
                                fontFamily: 'monospace',
                                fontSize: '12px',
                                padding: '12px',
                                border: '1px solid #ddd',
                                borderRadius: '4px',
                                resize: 'none',
                                minHeight: '400px'
                            }, placeholder: "Paste your JSON here..." }), _jsxs("div", { style: {
                                display: 'flex',
                                gap: '8px',
                                marginTop: '16px',
                                justifyContent: 'flex-end'
                            }, children: [_jsx("button", { onClick: closeJsonEdit, style: {
                                        background: '#6c757d',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        padding: '8px 16px',
                                        cursor: 'pointer'
                                    }, children: "Cancel" }), _jsx("button", { onClick: applyJsonEdit, style: {
                                        background: '#28a745',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '4px',
                                        padding: '8px 16px',
                                        cursor: 'pointer'
                                    }, children: "Apply Changes" })] })] }) }))] }));
}
