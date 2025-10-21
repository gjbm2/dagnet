import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo, useCallback } from 'react';
import { useGraphStore } from '@/lib/useGraphStore';
import { getConditionalColor, getConditionSignature } from '@/lib/conditionalColors';
export default function WhatIfAnalysisControl() {
    const { graph, whatIfAnalysis, setWhatIfAnalysis, whatIfOverrides, setCaseOverride, setConditionalOverride, clearAllOverrides } = useGraphStore();
    const [isExpanded, setIsExpanded] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    // Get all case nodes and conditional edges
    const caseNodes = useMemo(() => {
        if (!graph)
            return [];
        return graph.nodes.filter(n => n.type === 'case' && n.case?.variants);
    }, [graph]);
    const conditionalEdges = useMemo(() => {
        if (!graph)
            return [];
        return graph.edges.filter(e => e.conditional_p && e.conditional_p.length > 0);
    }, [graph]);
    // Group conditional edges by condition signature
    const conditionGroups = useMemo(() => {
        if (!graph)
            return [];
        const groups = new Map();
        conditionalEdges.forEach(edge => {
            const signature = getConditionSignature(edge);
            if (!groups.has(signature)) {
                groups.set(signature, []);
            }
            groups.get(signature).push(edge);
        });
        // Convert to array of objects
        return Array.from(groups.entries()).map(([signature, edges]) => ({
            signature,
            edges,
            color: edges[0]?.display?.conditional_color,
            // Create display name from first edge's conditions using node slugs
            displayName: edges[0]?.conditional_p?.[0]?.condition?.visited?.length > 0
                ? `visited(${edges[0].conditional_p[0].condition.visited.map((nodeId) => {
                    const node = graph?.nodes.find((n) => n.id === nodeId);
                    return node?.slug || node?.label || nodeId;
                }).join(', ')})`
                : 'Empty condition'
        }));
    }, [graph, conditionalEdges]);
    // Filter based on search
    const filteredCaseNodes = useMemo(() => {
        if (!searchTerm)
            return caseNodes;
        const term = searchTerm.toLowerCase();
        return caseNodes.filter(n => (n.label?.toLowerCase().includes(term)) ||
            (n.slug?.toLowerCase().includes(term)));
    }, [caseNodes, searchTerm]);
    const filteredConditionGroups = useMemo(() => {
        if (!searchTerm)
            return conditionGroups;
        const term = searchTerm.toLowerCase();
        return conditionGroups.filter(group => group.displayName.toLowerCase().includes(term) ||
            group.edges.some(e => (e.slug?.toLowerCase().includes(term)) ||
                (e.id?.toLowerCase().includes(term))));
    }, [conditionGroups, searchTerm]);
    // Count active overrides (including legacy whatIfAnalysis)
    const activeCount = (whatIfAnalysis ? 1 : 0) +
        (whatIfOverrides?.conditionalOverrides?.size || 0);
    // Get case node display name
    const getCaseNodeName = useCallback((nodeId) => {
        const node = graph?.nodes.find(n => n.id === nodeId);
        return node?.label || node?.slug || nodeId;
    }, [graph]);
    // Get conditional edge display name
    const getConditionalEdgeName = useCallback((edgeId) => {
        const edge = graph?.edges.find(e => e.id === edgeId);
        return edge?.slug || edge?.id || edgeId;
    }, [graph]);
    return (_jsxs("div", { style: {
            background: '#f8f9fa',
            border: '1px solid #ddd',
            borderRadius: '6px',
            padding: '12px',
            marginBottom: '16px'
        }, children: [_jsxs("div", { style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    userSelect: 'none'
                }, onClick: () => setIsExpanded(!isExpanded), children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [_jsx("span", { style: { fontSize: '18px' }, children: "\uD83C\uDFAD" }), _jsx("span", { style: { fontWeight: '600', fontSize: '14px' }, children: "What-If Analysis" }), activeCount > 0 && (_jsxs("span", { style: {
                                    background: '#007bff',
                                    color: 'white',
                                    borderRadius: '12px',
                                    padding: '2px 8px',
                                    fontSize: '11px',
                                    fontWeight: '600'
                                }, children: [activeCount, " active"] }))] }), _jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [activeCount > 0 && (_jsx("button", { onClick: (e) => {
                                    e.stopPropagation();
                                    setWhatIfAnalysis(null);
                                    clearAllOverrides();
                                }, style: {
                                    padding: '4px 12px',
                                    fontSize: '12px',
                                    background: '#dc3545',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer'
                                }, children: "Clear All" })), _jsx("span", { style: { fontSize: '14px', color: '#666' }, children: isExpanded ? '▾' : '▸' })] })] }), activeCount > 0 && !isExpanded && (_jsxs("div", { style: { marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px' }, children: [whatIfAnalysis && (_jsxs("div", { style: {
                            background: '#8B5CF6',
                            color: 'white',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            fontSize: '11px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                        }, children: [_jsxs("span", { children: ["\uD83C\uDFAD ", getCaseNodeName(whatIfAnalysis.caseNodeId), ": ", whatIfAnalysis.selectedVariant] }), _jsx("button", { onClick: () => setWhatIfAnalysis(null), style: {
                                    background: 'rgba(255,255,255,0.3)',
                                    border: 'none',
                                    color: 'white',
                                    borderRadius: '3px',
                                    cursor: 'pointer',
                                    padding: '0 4px',
                                    fontSize: '11px'
                                }, children: "\u00D7" })] })), Array.from(whatIfOverrides?.conditionalOverrides?.entries() || []).map(([edgeId, visitedNodes]) => {
                        const edge = graph?.edges.find(e => e.id === edgeId);
                        const edgeColor = edge ? (getConditionalColor(edge) || '#4ade80') : '#4ade80';
                        return (_jsxs("div", { style: {
                                background: edgeColor,
                                color: 'white',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }, children: [_jsxs("span", { children: ["\uD83D\uDD00 ", getConditionalEdgeName(edgeId)] }), _jsx("button", { onClick: () => setConditionalOverride(edgeId, null), style: {
                                        background: 'rgba(255,255,255,0.3)',
                                        border: 'none',
                                        color: 'white',
                                        borderRadius: '3px',
                                        cursor: 'pointer',
                                        padding: '0 4px',
                                        fontSize: '11px'
                                    }, children: "\u00D7" })] }, edgeId));
                    })] })), isExpanded && (_jsxs("div", { style: { marginTop: '12px' }, children: [_jsx("input", { type: "text", placeholder: "Search cases or conditional edges...", value: searchTerm, onChange: (e) => setSearchTerm(e.target.value), style: {
                            width: '100%',
                            padding: '8px',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            marginBottom: '12px',
                            boxSizing: 'border-box'
                        } }), filteredCaseNodes.length > 0 && (_jsxs("div", { style: { marginBottom: '16px' }, children: [_jsx("div", { style: { fontWeight: '600', fontSize: '13px', marginBottom: '8px', color: '#8B5CF6' }, children: "\uD83C\uDFAD Case Nodes" }), filteredCaseNodes.map(node => {
                                const isActive = whatIfAnalysis?.caseNodeId === node.id;
                                const variants = node.case?.variants || [];
                                const nodeColor = node.layout?.color || '#e5e7eb';
                                return (_jsxs("div", { style: {
                                        background: 'white',
                                        padding: '10px',
                                        marginBottom: '6px',
                                        borderRadius: '4px',
                                        border: isActive ? `2px solid ${nodeColor}` : '1px solid #e9ecef'
                                    }, children: [_jsxs("div", { style: {
                                                fontWeight: '600',
                                                fontSize: '12px',
                                                marginBottom: '6px',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '8px'
                                            }, children: [_jsx("div", { style: {
                                                        width: '16px',
                                                        height: '16px',
                                                        borderRadius: '2px',
                                                        background: nodeColor,
                                                        border: '1px solid rgba(0,0,0,0.2)',
                                                        flexShrink: 0
                                                    } }), node.label || node.slug] }), _jsxs("select", { value: isActive ? whatIfAnalysis.selectedVariant : '', onChange: (e) => {
                                                const variantName = e.target.value;
                                                if (variantName) {
                                                    setWhatIfAnalysis({
                                                        caseNodeId: node.id,
                                                        selectedVariant: variantName
                                                    });
                                                }
                                                else {
                                                    setWhatIfAnalysis(null);
                                                }
                                            }, style: {
                                                width: '100%',
                                                padding: '6px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                fontSize: '12px',
                                                background: isActive ? '#fff9e6' : 'white',
                                                fontWeight: isActive ? 'bold' : 'normal'
                                            }, children: [_jsx("option", { value: "", children: "All variants (actual weights)" }), variants.map(variant => (_jsxs("option", { value: variant.name, children: [variant.name, " - What if 100%?"] }, variant.name)))] })] }, node.id));
                            })] })), filteredConditionGroups.length > 0 && (_jsxs("div", { children: [_jsx("div", { style: { fontWeight: '600', fontSize: '13px', marginBottom: '8px', color: '#4ade80' }, children: "\uD83D\uDD00 Conditional Probability Groups" }), filteredConditionGroups.map((group, groupIdx) => {
                                // Check if any edge in this group has an active override
                                const anyActive = group.edges.some(e => whatIfOverrides?.conditionalOverrides?.has(e.id));
                                const groupColor = group.color || '#4ade80';
                                return (_jsxs("div", { style: {
                                        background: 'white',
                                        padding: '10px',
                                        marginBottom: '6px',
                                        borderRadius: '4px',
                                        border: anyActive ? `2px solid ${groupColor}` : '1px solid #e9ecef'
                                    }, children: [_jsxs("div", { style: { marginBottom: '6px' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }, children: [_jsx("div", { style: {
                                                                width: '12px',
                                                                height: '12px',
                                                                borderRadius: '2px',
                                                                background: groupColor,
                                                                border: '1px solid #ddd'
                                                            } }), _jsx("span", { style: { fontWeight: '600', fontSize: '12px' }, children: group.displayName })] }), _jsxs("div", { style: { fontSize: '10px', color: '#6c757d', marginLeft: '18px' }, children: ["Affects ", group.edges.length, " edge", group.edges.length > 1 ? 's' : ''] })] }), _jsxs("select", { value: (() => {
                                                if (!anyActive || !whatIfOverrides?.conditionalOverrides)
                                                    return '';
                                                const override = whatIfOverrides.conditionalOverrides.get(group.edges[0].id);
                                                if (!override)
                                                    return '';
                                                // The override contains IDs, need to find matching option
                                                // Match by comparing resolved IDs
                                                const overrideIds = Array.from(override).sort().join(',');
                                                const matchingCond = group.edges[0]?.conditional_p?.find(cond => {
                                                    const condIds = cond.condition.visited.map(ref => {
                                                        const nodeById = graph?.nodes.find(n => n.id === ref);
                                                        if (nodeById)
                                                            return nodeById.id;
                                                        const nodeBySlug = graph?.nodes.find(n => n.slug === ref);
                                                        if (nodeBySlug)
                                                            return nodeBySlug.id;
                                                        return ref;
                                                    }).sort().join(',');
                                                    return condIds === overrideIds;
                                                });
                                                return matchingCond ? matchingCond.condition.visited.join(',') : '';
                                            })(), onChange: (e) => {
                                                const value = e.target.value;
                                                // Apply to ALL edges in the group
                                                group.edges.forEach(edge => {
                                                    if (!value) {
                                                        setConditionalOverride(edge.id, null);
                                                    }
                                                    else {
                                                        const nodeRefs = value.split(',');
                                                        // Resolve all references (could be slugs or IDs) to actual IDs
                                                        const resolvedIds = nodeRefs.map(ref => {
                                                            // Try to find by ID first
                                                            const nodeById = graph?.nodes.find(n => n.id === ref);
                                                            if (nodeById)
                                                                return nodeById.id;
                                                            // Try by slug
                                                            const nodeBySlug = graph?.nodes.find(n => n.slug === ref);
                                                            if (nodeBySlug)
                                                                return nodeBySlug.id;
                                                            // Return as-is if not found
                                                            return ref;
                                                        });
                                                        setConditionalOverride(edge.id, new Set(resolvedIds));
                                                    }
                                                });
                                            }, style: {
                                                width: '100%',
                                                padding: '6px',
                                                border: '1px solid #ddd',
                                                borderRadius: '4px',
                                                fontSize: '12px',
                                                background: anyActive ? '#fff9e6' : 'white',
                                                fontWeight: anyActive ? 'bold' : 'normal'
                                            }, children: [_jsx("option", { value: "", children: "Base probabilities" }), group.edges[0]?.conditional_p?.map((cond, idx) => {
                                                    const nodeNames = cond.condition.visited.map(nid => {
                                                        const n = graph?.nodes.find(node => node.id === nid);
                                                        return n?.label || n?.slug || nid;
                                                    }).join(', ');
                                                    return (_jsxs("option", { value: cond.condition.visited.join(','), children: ["What if: visited(", nodeNames, ")?"] }, idx));
                                                })] })] }, group.signature));
                            })] })), filteredCaseNodes.length === 0 && conditionalEdges.length === 0 && (_jsx("div", { style: { textAlign: 'center', padding: '20px', color: '#666' }, children: searchTerm ? 'No matching cases or conditional edges' : 'No cases or conditional edges in this graph' }))] }))] }));
}
