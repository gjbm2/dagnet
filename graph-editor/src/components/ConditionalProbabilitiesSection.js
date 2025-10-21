import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { getUpstreamNodes, validateConditionalProbabilities } from '@/lib/conditionalValidation';
import { getConditionalColor, CONDITIONAL_COLOR_PALETTE, getNextAvailableColor, getSiblingEdges, getConditionSignature } from '@/lib/conditionalColors';
export default function ConditionalProbabilitiesSection({ edge, graph, setGraph, localConditionalP, setLocalConditionalP, onLocalUpdate, onUpdateColor }) {
    const [isExpanded, setIsExpanded] = useState(true);
    // Get upstream nodes for condition selection
    const upstreamNodes = useMemo(() => {
        if (!graph)
            return [];
        return getUpstreamNodes(edge.from, graph);
    }, [graph, edge.from]);
    // Use local state from props (like variants do)
    const conditions = localConditionalP;
    // Get sibling edges and condition group info
    const siblings = useMemo(() => getSiblingEdges(edge, graph), [edge, graph]);
    const allEdgesWithConditions = useMemo(() => {
        return [edge, ...siblings].filter(e => e.conditional_p && e.conditional_p.length > 0);
    }, [edge, siblings]);
    // Run validation
    const validation = useMemo(() => {
        return validateConditionalProbabilities(graph);
    }, [graph]);
    // Find errors/warnings for this edge's source node
    const relevantErrors = validation.errors.filter(err => err.message.includes(edge.from) || err.message.includes(edge.to));
    const relevantWarnings = validation.warnings.filter(warn => warn.message.includes(edge.from) || warn.message.includes(edge.to));
    // Get condition signature for grouping
    const conditionSignature = conditions.length > 0 ? getConditionSignature(edge) : null;
    const edgesInGroup = conditionSignature ? allEdgesWithConditions.filter(e => getConditionSignature(e) === conditionSignature) : [];
    return (_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsxs("div", { onClick: () => setIsExpanded(!isExpanded), style: {
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px',
                    background: '#f8f9fa',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    marginBottom: isExpanded ? '12px' : '0',
                    border: '1px solid #dee2e6'
                }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: '8px' }, children: [_jsx("span", { style: { fontWeight: '600', fontSize: '13px' }, children: "\uD83D\uDD00 Conditional Probabilities" }), conditions.length > 0 && (_jsx("span", { style: {
                                    background: '#4ade80',
                                    color: 'white',
                                    padding: '2px 8px',
                                    borderRadius: '10px',
                                    fontSize: '11px',
                                    fontWeight: 'bold'
                                }, children: conditions.length }))] }), _jsx("span", { style: { fontSize: '14px', color: '#666' }, children: isExpanded ? '▾' : '▸' })] }), isExpanded && (_jsxs("div", { children: [conditions.map((condition, index) => (_jsxs("div", { style: {
                            marginBottom: '12px',
                            padding: '12px',
                            border: '1px solid #ddd',
                            borderRadius: '4px',
                            background: '#f9f9f9'
                        }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }, children: [_jsxs("span", { style: { fontWeight: '600', fontSize: '12px' }, children: ["Condition ", index + 1] }), _jsx("button", { type: "button", onClick: () => {
                                            const newConditions = conditions.filter((_, i) => i !== index);
                                            onLocalUpdate(newConditions);
                                        }, style: {
                                            background: '#dc3545',
                                            color: 'white',
                                            border: 'none',
                                            borderRadius: '3px',
                                            padding: '4px 8px',
                                            cursor: 'pointer',
                                            fontSize: '10px'
                                        }, children: "\u2715 Remove" })] }), _jsxs("div", { style: { marginBottom: '8px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }, children: "When visited nodes (select multiple):" }), _jsx("div", { style: {
                                            border: '1px solid #ddd',
                                            borderRadius: '3px',
                                            padding: '8px',
                                            background: 'white',
                                            maxHeight: '120px',
                                            overflowY: 'auto'
                                        }, children: upstreamNodes.map((node) => (_jsxs("label", { style: {
                                                display: 'block',
                                                padding: '4px',
                                                cursor: 'pointer',
                                                fontSize: '12px'
                                            }, children: [_jsx("input", { type: "checkbox", checked: condition.condition.visited.includes(node.slug) ||
                                                        condition.condition.visited.includes(node.id), onChange: (e) => {
                                                        const newConditions = [...conditions];
                                                        let visited = [...condition.condition.visited];
                                                        if (e.target.checked) {
                                                            // ALWAYS use slug for new entries (immutable references)
                                                            if (!visited.includes(node.slug) && !visited.includes(node.id)) {
                                                                visited.push(node.slug);
                                                            }
                                                        }
                                                        else {
                                                            // Remove both slug and ID (for backward compatibility)
                                                            visited = visited.filter(ref => ref !== node.slug && ref !== node.id);
                                                        }
                                                        newConditions[index] = {
                                                            ...condition,
                                                            condition: { visited }
                                                        };
                                                        onLocalUpdate(newConditions);
                                                    }, style: { marginRight: '6px' } }), node.label || node.slug] }, node.id))) })] }), _jsxs("div", { style: { marginBottom: '8px' }, children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }, children: "Probability (mean)" }), _jsx("input", { type: "number", min: "0", max: "1", step: "0.01", value: condition.p.mean, onChange: (e) => {
                                            const newConditions = [...conditions];
                                            newConditions[index] = {
                                                ...condition,
                                                p: { ...condition.p, mean: parseFloat(e.target.value) || 0 }
                                            };
                                            onLocalUpdate(newConditions);
                                        }, placeholder: "0.5", style: {
                                            width: '100%',
                                            padding: '6px',
                                            border: '1px solid #ddd',
                                            borderRadius: '3px',
                                            boxSizing: 'border-box',
                                            fontSize: '12px'
                                        } })] }), _jsxs("div", { children: [_jsx("label", { style: { display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: '600' }, children: "Std Dev (optional)" }), _jsx("input", { type: "number", min: "0", max: "1", step: "0.01", value: condition.p.stdev || '', onChange: (e) => {
                                            const newConditions = [...conditions];
                                            newConditions[index] = {
                                                ...condition,
                                                p: { ...condition.p, stdev: parseFloat(e.target.value) || undefined }
                                            };
                                            onLocalUpdate(newConditions);
                                        }, placeholder: "0.05", style: {
                                            width: '100%',
                                            padding: '6px',
                                            border: '1px solid #ddd',
                                            borderRadius: '3px',
                                            boxSizing: 'border-box',
                                            fontSize: '12px'
                                        } })] })] }, index))), (relevantErrors.length > 0 || relevantWarnings.length > 0) && (_jsxs("div", { style: { marginBottom: '12px' }, children: [relevantErrors.map((error, idx) => (_jsxs("div", { style: {
                                    padding: '8px',
                                    background: '#fee',
                                    border: '1px solid #fcc',
                                    borderRadius: '4px',
                                    marginBottom: '4px',
                                    fontSize: '11px',
                                    color: '#c00'
                                }, children: ["\u26A0\uFE0F ", _jsx("strong", { children: "Error:" }), " ", error.message] }, `error-${idx}`))), relevantWarnings.map((warning, idx) => (_jsxs("div", { style: {
                                    padding: '8px',
                                    background: '#fffbea',
                                    border: '1px solid #ffd700',
                                    borderRadius: '4px',
                                    marginBottom: '4px',
                                    fontSize: '11px',
                                    color: '#856404'
                                }, children: ["\u26A0\uFE0F ", _jsx("strong", { children: "Warning:" }), " ", warning.message] }, `warning-${idx}`)))] })), conditionSignature && edgesInGroup.length > 1 && (_jsxs("div", { style: {
                            padding: '10px',
                            background: '#f8f9fa',
                            border: '1px solid #dee2e6',
                            borderRadius: '4px',
                            marginBottom: '12px'
                        }, children: [_jsx("div", { style: { fontSize: '11px', fontWeight: '600', marginBottom: '6px', color: '#495057' }, children: "\uD83D\uDCE6 Condition Group" }), _jsxs("div", { style: { fontSize: '11px', color: '#6c757d', marginBottom: '4px' }, children: ["Affects ", _jsx("strong", { children: edgesInGroup.length }), " sibling edges"] }), _jsxs("div", { style: {
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    fontSize: '11px',
                                    color: '#6c757d'
                                }, children: [_jsx("span", { style: {
                                            width: '12px',
                                            height: '12px',
                                            borderRadius: '2px',
                                            background: edge.display?.conditional_color || '#ccc',
                                            display: 'inline-block'
                                        } }), _jsx("span", { children: "Shared color" })] })] })), _jsx("button", { type: "button", onClick: () => {
                            // Create new condition for this edge (copying its current base probability)
                            const newCondition = {
                                condition: { visited: [] },
                                p: {
                                    mean: edge.p?.mean ?? 0.5,
                                    ...(edge.p?.stdev !== undefined ? { stdev: edge.p.stdev } : {})
                                }
                            };
                            // Get all sibling edges (same source node)
                            const siblings = getSiblingEdges(edge, graph);
                            // Assign a fresh color for this condition group
                            const color = getNextAvailableColor(graph);
                            // Update ALL siblings (including this edge) in one transaction
                            const nextGraph = structuredClone(graph);
                            const edgeIds = [edge.id, ...siblings.map(s => s.id)];
                            edgeIds.forEach(edgeId => {
                                const edgeIndex = nextGraph.edges.findIndex((e) => e.id === edgeId || `${e.from}->${e.to}` === edgeId);
                                if (edgeIndex >= 0) {
                                    const targetEdge = nextGraph.edges[edgeIndex];
                                    // Create condition using this edge's base probability
                                    const conditionForThisEdge = {
                                        condition: { visited: [] },
                                        p: {
                                            mean: targetEdge.p?.mean ?? 0.5,
                                            ...(targetEdge.p?.stdev !== undefined ? { stdev: targetEdge.p.stdev } : {})
                                        }
                                    };
                                    // Add condition
                                    if (!targetEdge.conditional_p) {
                                        targetEdge.conditional_p = [];
                                    }
                                    targetEdge.conditional_p.push(conditionForThisEdge);
                                    // Set color
                                    if (!targetEdge.display) {
                                        targetEdge.display = {};
                                    }
                                    targetEdge.display.conditional_color = color;
                                }
                            });
                            // Update metadata
                            if (!nextGraph.metadata)
                                nextGraph.metadata = {};
                            nextGraph.metadata.updated_at = new Date().toISOString();
                            // Apply to graph
                            setGraph(nextGraph);
                            // Update local state for the current edge
                            const newConditions = [...conditions, newCondition];
                            setLocalConditionalP(newConditions);
                        }, style: {
                            background: '#28a745',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            padding: '8px 16px',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600',
                            width: '100%',
                            marginBottom: '12px'
                        }, children: "+ Add Condition" }), conditions.length > 0 && (_jsxs("div", { style: {
                            padding: '10px',
                            background: 'white',
                            borderRadius: '4px',
                            border: '1px solid #e9ecef'
                        }, children: [_jsx("div", { style: { fontSize: '12px', fontWeight: '600', marginBottom: '8px' }, children: "Edge Color" }), _jsx("div", { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '8px' }, children: CONDITIONAL_COLOR_PALETTE.map((color) => (_jsx("button", { onClick: () => onUpdateColor(color), style: {
                                        width: '28px',
                                        height: '28px',
                                        borderRadius: '4px',
                                        border: (edge.display?.conditional_color || getConditionalColor(edge)) === color
                                            ? '3px solid #007bff'
                                            : '1px solid #ddd',
                                        background: color,
                                        cursor: 'pointer',
                                        padding: 0
                                    }, title: color }, color))) }), _jsxs("div", { style: { display: 'flex', gap: '6px', alignItems: 'center' }, children: [_jsx("input", { type: "color", value: edge.display?.conditional_color || getConditionalColor(edge) || '#4ade80', onChange: (e) => {
                                            e.stopPropagation();
                                            onUpdateColor(e.target.value);
                                        }, onInput: (e) => {
                                            e.stopPropagation();
                                            const target = e.target;
                                            onUpdateColor(target.value);
                                        }, style: {
                                            width: '40px',
                                            height: '28px',
                                            border: '1px solid #ddd',
                                            borderRadius: '4px',
                                            cursor: 'pointer'
                                        } }), _jsxs("span", { style: { fontSize: '11px', color: '#666', flex: 1 }, children: ["Current: ", edge.display?.conditional_color || 'Auto'] }), edge.display?.conditional_color && (_jsx("button", { onClick: () => onUpdateColor(undefined), style: {
                                            padding: '4px 8px',
                                            fontSize: '11px',
                                            background: '#f1f1f1',
                                            border: '1px solid #ddd',
                                            borderRadius: '3px',
                                            cursor: 'pointer'
                                        }, children: "Reset" }))] })] })), conditions.length === 0 && (_jsxs("div", { style: { textAlign: 'center', padding: '20px', color: '#666' }, children: [_jsx("div", { style: { fontSize: '24px', marginBottom: '8px' }, children: "\uD83D\uDD00" }), _jsx("div", { style: { fontSize: '13px' }, children: "No conditions defined" }), _jsx("div", { style: { fontSize: '11px', marginTop: '4px', color: '#999' }, children: "Add conditions to vary probability based on visited nodes" })] }))] }))] }));
}
