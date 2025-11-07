import React, { useRef, useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { X, MapPinCheckInside, MapPinXInside, ArrowRightFromLine, ArrowLeftFromLine, GitBranch } from 'lucide-react';
import './QueryExpressionEditor.css';

interface QueryExpressionEditorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  graph: any;
  edgeId?: string;
  placeholder?: string;
  height?: string;
  readonly?: boolean;
  
  // Self-contained mode: handle override state internally
  overridden?: boolean;
  onClearOverride?: () => void;
  label?: string;
  showLabel?: boolean;
  infoTooltip?: string;
}

interface ParsedQueryChip {
  type: 'from' | 'to' | 'exclude' | 'visited' | 'case';
  values: string[];
  rawText: string;
}

/**
 * Monaco-based Query Expression Editor
 * 
 * Provides IDE-like autocomplete for constructing data retrieval queries:
 * - from(node-id).to(node-id)
 * - .exclude(node-id, node-id, ...)
 * - .visited(node-id, node-id, ...)
 * - .case(case-id:variant-name)
 */
// Chip styling configuration for outer chips (neutral)
const outerChipConfig = {
  from: { 
    label: 'from', 
    icon: ArrowRightFromLine
  },
  to: { 
    label: 'to', 
    icon: ArrowLeftFromLine
  },
  exclude: { 
    label: 'exclude', 
    icon: MapPinXInside
  },
  visited: { 
    label: 'visited', 
    icon: MapPinCheckInside
  },
  case: { 
    label: 'case', 
    icon: GitBranch
  }
};

// Inner chip styling by type
const innerChipConfig = {
  node: {
    bgColor: '#DBEAFE',  // Light blue
    textColor: '#1E40AF',
    borderColor: '#93C5FD'
  },
  case: {
    bgColor: '#E9D5FF',  // Light purple
    textColor: '#6B21A8',
    borderColor: '#C084FC'
  }
};

// Parse query string into chips
function parseQueryToChips(query: string): ParsedQueryChip[] {
  if (!query) return [];
  
  const chips: ParsedQueryChip[] = [];
  
  // Match from(...)
  const fromMatch = query.match(/from\(([^)]+)\)/);
  if (fromMatch) {
    chips.push({
      type: 'from',
      values: [fromMatch[1]],
      rawText: fromMatch[0]
    });
  }
  
  // Match to(...)
  const toMatch = query.match(/to\(([^)]+)\)/);
  if (toMatch) {
    chips.push({
      type: 'to',
      values: [toMatch[1]],
      rawText: toMatch[0]
    });
  }
  
  // Match exclude(...)
  const excludeMatch = query.match(/exclude\(([^)]+)\)/);
  if (excludeMatch) {
    chips.push({
      type: 'exclude',
      values: excludeMatch[1].split(',').map(s => s.trim()),
      rawText: excludeMatch[0]
    });
  }
  
  // Match visited(...)
  const visitedMatch = query.match(/visited\(([^)]+)\)/);
  if (visitedMatch) {
    chips.push({
      type: 'visited',
      values: visitedMatch[1].split(',').map(s => s.trim()),
      rawText: visitedMatch[0]
    });
  }
  
  // Match case(...)
  const caseMatch = query.match(/case\(([^)]+)\)/);
  if (caseMatch) {
    chips.push({
      type: 'case',
      values: [caseMatch[1]],
      rawText: caseMatch[0]
    });
  }
  
  return chips;
}

export function QueryExpressionEditor({
  value,
  onChange,
  onBlur,
  graph,
  edgeId,
  placeholder = 'from(node).to(node)',
  height = '60px',
  readonly = false
}: QueryExpressionEditorProps) {
  const monacoRef = useRef<typeof Monaco | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [nodeRegistry, setNodeRegistry] = useState<any[]>([]);
  const [caseRegistry, setCaseRegistry] = useState<any[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [chips, setChips] = useState<ParsedQueryChip[]>([]);
  const [hoveredChipIndex, setHoveredChipIndex] = useState<number | null>(null);
  const [hoveredInnerChip, setHoveredInnerChip] = useState(false);
  const [editorHeight, setEditorHeight] = useState(height);
  
  // Parse value into chips when it changes
  useEffect(() => {
    console.log('[QueryExpressionEditor] Value changed, parsing to chips:', { 
      value, 
      isEditing,
      chipsCount: parseQueryToChips(value).length 
    });
    setChips(parseQueryToChips(value));
  }, [value, isEditing]);
  
  // Calculate editor height based on content
  useEffect(() => {
    if (!value || !isEditing) {
      setEditorHeight(height);
      return;
    }
    
    // Estimate lines based on content length and wrapping
    // Rough calculation: ~50 chars per line at default width
    const estimatedLines = Math.ceil(value.length / 50);
    const lineCount = Math.max(1, Math.min(estimatedLines, 5)); // Min 1, max 5 lines
    const lineHeight = 20; // Approximate line height
    const padding = 16; // Top and bottom padding
    const calculatedHeight = (lineCount * lineHeight) + padding;
    
    setEditorHeight(`${calculatedHeight}px`);
  }, [value, isEditing, height]);
  
  // Load registries
  useEffect(() => {
    const loadRegistries = async () => {
      try {
        const { registryService } = await import('../services/registryService');
        
        // Load node registry
        const nodes = await registryService.getItems('node');
        setNodeRegistry(nodes || []);
        
        // Load case registry
        const cases = await registryService.getItems('case');
        setCaseRegistry(cases || []);
      } catch (error) {
        console.warn('Failed to load registries:', error);
      }
    };
    
    loadRegistries();
  }, []);
  
  // Get current edge to pre-fill from/to
  const currentEdge = edgeId && graph?.edges
    ? graph.edges.find((e: any) => e.uuid === edgeId || e.id === edgeId || `${e.from}->${e.to}` === edgeId)
    : null;
  
  // Merge nodes from graph and registry (using ids from graph, IDs from registry)
  const graphNodes = (graph?.nodes || []).map((n: any) => ({
    id: n.id || n.id,  // Prefer id over ID
    label: n.label || n.id || n.id,
    description: n.description,
    source: 'graph'
  }));
  
  const registryNodes = nodeRegistry.map((n: any) => ({
    id: n.id,
    label: n.name || n.id,
    description: n.description,
    source: 'registry'
  }));
  
  // Union: prefer graph nodes (by ID/id), add registry nodes not in graph
  const graphNodeIds = new Set(graphNodes.map((n: any) => n.id));
  const allNodes = [
    ...graphNodes,
    ...registryNodes.filter((n: any) => !graphNodeIds.has(n.id))
  ];
  
  // Merge cases from graph and registry
  const graphCases = (graph?.nodes || [])
    .filter((n: any) => n.type === 'case' && n.case)
    .map((n: any) => ({
      id: n.case.id || n.id,
      name: n.case.id || n.label,
      variants: (n.case.variants || []).map((v: any) => v.name),
      source: 'graph'
    }));
  
  const registryCases = caseRegistry.map((c: any) => ({
    id: c.id,
    name: c.name || c.id,
    variants: c.variants || [],
    source: 'registry'
  }));
  
  // Union: prefer graph cases, add registry cases not in graph
  const graphCaseIds = new Set(graphCases.map((c: any) => c.id));
  const allCases = [
    ...graphCases,
    ...registryCases.filter((c: any) => !graphCaseIds.has(c.id))
  ];
  
  const handleEditorDidMount = (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    
    // Register custom language for query expressions (only once)
    const languages = monaco.languages.getLanguages();
    if (!languages.find(l => l.id === 'dagnet-query')) {
      monaco.languages.register({ id: 'dagnet-query' });
      
      // Syntax highlighting (Monarch tokenizer)
      monaco.languages.setMonarchTokensProvider('dagnet-query', {
      keywords: ['from', 'to', 'exclude', 'visited', 'case'],
      
      tokenizer: {
        root: [
          [/\b(from|to|exclude|visited|case)\b/, 'keyword'],
          [/[a-z0-9_-]+/, 'identifier'],
          [/[().,:]/, 'delimiter'],
        ]
      }
    });
    
    // Theme colors (using app's color scheme)
    monaco.editor.defineTheme('dagnet-query-theme', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '3B82F6', fontStyle: 'bold' },  // Blue for from/to
        { token: 'identifier', foreground: '1F2937' },  // Dark gray for node IDs
        { token: 'delimiter', foreground: '6B7280' },  // Medium gray for punctuation
      ],
      colors: {
        'editor.background': '#FFFFFF',
        'editor.foreground': '#1F2937'
      }
    });
    
      monaco.editor.setTheme('dagnet-query-theme');
      
      // Autocomplete (CompletionItemProvider)
      monaco.languages.registerCompletionItemProvider('dagnet-query', {
      triggerCharacters: ['.', '(', ',', ':'],
      
      provideCompletionItems: (model, position) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });
        
        // Check if there's a selection - if so, use that as the range to replace
        const selection = editor.getSelection();
        let range;
        if (selection && !selection.isEmpty()) {
          // Use the selection range for replacement
          range = {
            startLineNumber: selection.startLineNumber,
            startColumn: selection.startColumn,
            endLineNumber: selection.endLineNumber,
            endColumn: selection.endColumn
          };
        } else {
          // Otherwise use word range
          const word = model.getWordUntilPosition(position);
          range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          };
        }
        
        // After from( → suggest node IDs (graph + registry)
        if (/from\([^)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allNodes.map((n: any) => ({
              label: n.label,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: n.id,
              documentation: n.description || `Node: ${n.label}`,
              detail: `${n.id} (${n.source})`,
              range
            }))
          };
        }
        
        // After to( → suggest node IDs (graph + registry)
        if (/to\([^)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allNodes.map((n: any) => ({
              label: n.label,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: n.id,
              documentation: n.description || `Node: ${n.label}`,
              detail: `${n.id} (${n.source})`,
              range
            }))
          };
        }
        
        // After .exclude( or .visited( → suggest node IDs (graph + registry)
        if (/\.(exclude|visited)\([^)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allNodes.map((n: any) => ({
              label: n.label,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: n.id,
              documentation: n.description || `Node: ${n.label}`,
              detail: `${n.id} (${n.source})`,
              range
            }))
          };
        }
        
        // After .case( → suggest case IDs (graph + registry)
        if (/\.case\([^:)]*$/.test(textUntilPosition)) {
          return {
            suggestions: allCases.map((c: any) => ({
              label: c.name,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: c.id,
              documentation: `Case: ${c.name}`,
              detail: `${c.id} (${c.source})`,
              range
            }))
          };
        }
        
        // After .case(case-id: → suggest variant names
        if (/\.case\([a-z0-9_-]+:([^)]*)$/.test(textUntilPosition)) {
          const match = textUntilPosition.match(/\.case\(([a-z0-9_-]+):/);
          if (match) {
            const caseId = match[1];
            const matchedCase = allCases.find((c: any) => c.id === caseId);
            if (matchedCase && matchedCase.variants) {
              return {
                suggestions: matchedCase.variants.map((variantName: string) => ({
                  label: variantName,
                  kind: monaco.languages.CompletionItemKind.Value,
                  insertText: variantName,
                  documentation: `Variant: ${variantName}`,
                  range
                }))
              };
            }
          }
        }
        
        // After . (dot) → suggest constraint types OR from/to/case
        if (/\.$/.test(textUntilPosition) || /\)\.$/.test(textUntilPosition)) {
          const hasSuggestions: any[] = [];
          
          // If no 'from' yet, suggest it
          if (!/from\(/.test(textUntilPosition)) {
            hasSuggestions.push({
              label: 'from',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'from($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Start path at this node',
              detail: '.from(node-id)',
              range,
              sortText: '0'
            });
          }
          
          // If has 'from' but no 'to', suggest it
          if (/from\([^)]+\)/.test(textUntilPosition) && !/to\(/.test(textUntilPosition)) {
            hasSuggestions.push({
              label: 'to',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'to($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'End path at this node',
              detail: '.to(node-id)',
              range,
              sortText: '1'
            });
          }
          
          // Always suggest constraint types
          hasSuggestions.push(
            {
              label: 'exclude',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'exclude($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Exclude nodes from path (rules out paths containing these nodes)',
              detail: '.exclude(node-id, ...)',
              range,
              sortText: '2'
            },
            {
              label: 'visited',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'visited($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Must visit these nodes (rules out paths NOT containing these nodes)',
              detail: '.visited(node-id, ...)',
              range,
              sortText: '3'
            },
            {
              label: 'case',
              kind: monaco.languages.CompletionItemKind.Function,
              insertText: 'case($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Filter by case variant',
              detail: '.case(case-id:variant-name)',
              range,
              sortText: '4'
            }
          );
          
          return { suggestions: hasSuggestions };
        }
        
        // At start of line or after ) → suggest from/to
        if (/^$/.test(textUntilPosition) || /\)$/.test(textUntilPosition)) {
          const suggestions: any[] = [];
          
          if (!/^from\(/.test(textUntilPosition)) {
            suggestions.push({
              label: 'from',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: 'from($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'Start path at this node',
              detail: 'from(node-id)',
              range
            });
          }
          
          if (!/to\(/.test(textUntilPosition) && /from\([^)]+\)/.test(textUntilPosition)) {
            suggestions.push({
              label: 'to',
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: '.to($0)',
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'End path at this node',
              detail: '.to(node-id)',
              range
            });
          }
          
          return { suggestions };
        }
        
        return { suggestions: [] };
      }
    });
    } // End of language registration check
    
    // Add focus/blur handlers
    let injectedDot = false;
    
    editor.onDidFocusEditorText(() => {
      setIsEditing(true);
      // Trigger autocomplete immediately on focus
      setTimeout(() => {
        editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
      }, 50);
    });
    
    // Handle clicks in the editor
    editor.onMouseDown((e) => {
      const model = editor.getModel();
      if (!model) return;
      
      const clickedPosition = e.target.position;
      const text = model.getValue();
      const endPosition = model.getPositionAt(text.length);
      
      // If user clicked on empty space or at the end of text, move cursor to end and inject '.'
      if (!clickedPosition || 
          (clickedPosition.lineNumber === endPosition.lineNumber && 
           clickedPosition.column >= endPosition.column)) {
        
        setTimeout(() => {
          // Move cursor to end
          editor.setPosition(endPosition);
          
          // Inject '.' if text doesn't already end with one
          if (text.length > 0 && !text.endsWith('.') && !text.endsWith('(') && !text.endsWith(',')) {
            editor.executeEdits('click-inject', [{
              range: {
                startLineNumber: endPosition.lineNumber,
                startColumn: endPosition.column,
                endLineNumber: endPosition.lineNumber,
                endColumn: endPosition.column
              },
              text: '.'
            }]);
            injectedDot = true;
            
            // Trigger autocomplete
            setTimeout(() => {
              editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
            }, 50);
          }
        }, 0);
      }
    });
    
    editor.onDidBlurEditorText(() => {
      const model = editor.getModel();
      const currentText = model ? model.getValue() : '';
      
      console.log('[QueryExpressionEditor] Editor blur, switching to chip view:', { 
        currentText,
        injectedDot,
        willCallOnBlur: !!onBlur
      });
      
      setIsEditing(false);
      
      // Clean up trailing '.' if it was injected and user didn't type anything else
      if (injectedDot) {
        if (model) {
          const text = model.getValue();
          if (text.endsWith('.')) {
            // Check if there's a valid term before the dot, or if it's just a trailing dot
            const beforeDot = text.slice(0, -1);
            // If the dot is truly trailing (not part of a chain like .visited.), remove it
            if (!beforeDot.match(/\([^)]*$/)) {  // Not in the middle of a term
              console.log('[QueryExpressionEditor] Removing injected trailing dot:', { from: text, to: beforeDot });
              onChange(beforeDot);
            }
          }
        }
        injectedDot = false;
      }
      
      if (onBlur) {
        onBlur();
      }
    });
    
    // Handle Tab key to move to next field
    editor.addCommand(monaco.KeyCode.Tab, () => {
      // Blur the editor, which will trigger focus on next field
      editor.getContainerDomNode()?.blur();
      // Move focus to next focusable element
      const nextElement = document.activeElement?.nextElementSibling as HTMLElement;
      if (nextElement?.focus) {
        nextElement.focus();
      }
    });
    
    // Trigger autocomplete after typing "("
    editor.onDidChangeModelContent((e) => {
      const model = editor.getModel();
      if (!model) return;
      
      const position = editor.getPosition();
      if (!position) return;
      
      const textBeforeCursor = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - 1),
        endLineNumber: position.lineNumber,
        endColumn: position.column
      });
      
      // If user just typed "(", trigger suggestions
      if (textBeforeCursor === '(') {
        setTimeout(() => {
          editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }, 50);
      }
    });
    
    // Don't auto-focus (let user click to edit)
    // editor.focus();
  };
  
  // Auto-fill from/to if empty and edge is selected
  useEffect(() => {
    if (!value && currentEdge && editorRef.current && monacoRef.current) {
      const fromNode = allNodes.find((n: any) => n.id === currentEdge.from || n.id === currentEdge.from);
      const toNode = allNodes.find((n: any) => n.id === currentEdge.to || n.id === currentEdge.to);
      
      if (fromNode && toNode) {
        const autoValue = `from(${fromNode.id}).to(${toNode.id})`;
        onChange(autoValue);
      }
    }
  }, [value, currentEdge, allNodes, onChange]);
  
  // Focus Monaco when entering edit mode, clear hover state when leaving
  useEffect(() => {
    console.log('[QueryExpressionEditor] isEditing changed:', { 
      isEditing, 
      currentValue: value,
      hasEditor: !!editorRef.current
    });
    
    if (isEditing) {
      if (editorRef.current) {
        setTimeout(() => {
          editorRef.current?.focus();
        }, 50);
      }
    } else {
      // Clear hover state when returning to chip view
      setHoveredChipIndex(null);
    }
  }, [isEditing, value]);
  
  // Delete an inner chip value
  const handleDeleteInnerChip = (chip: ParsedQueryChip, valueToDelete: string, vIndex: number, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    const newValues = chip.values.filter((_, i) => i !== vIndex);
    
    if (newValues.length === 0) {
      // If no values left, remove the entire chip
      handleDeleteChip(chip, e);
      return;
    }
    
    // Find the position of this specific value within the chip
    const chipStartIndex = value.indexOf(chip.rawText);
    const valueStartInChip = chip.rawText.indexOf(valueToDelete);
    const cursorPosition = chipStartIndex + valueStartInChip;
    
    // Replace with updated values
    const newValuesStr = newValues.join(', ');
    const newTerm = `${chip.type}(${newValuesStr})`;
    const newQuery = value.replace(chip.rawText, newTerm);
    onChange(newQuery);
    
    // Enter edit mode and position cursor at the deletion point
    setIsEditing(true);
    
    setTimeout(() => {
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (!model) return;
        
        // Position cursor at the deletion point
        const cursorPos = model.getPositionAt(Math.min(cursorPosition, newQuery.length));
        editorRef.current.setPosition(cursorPos);
        editorRef.current.focus();
        
        // Trigger autocomplete
        setTimeout(() => {
          editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }, 50);
      }
    }, 100);
  };
  
  // Delete a chip (entire term)
  const handleDeleteChip = (chipToDelete: ParsedQueryChip, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger edit mode
    e.preventDefault(); // Prevent any default action
    
    // Calculate cursor position before deletion
    const startIndex = value.indexOf(chipToDelete.rawText);
    
    // Remove this chip from the query string
    let newQuery = value.replace(chipToDelete.rawText, '').replace(/\.+/g, '.').replace(/^\.|\.$/g, '').trim();
    
    // If the query now ends with a dot and there's content, add a dot for autocomplete
    if (newQuery && !newQuery.endsWith('.') && startIndex === value.length - chipToDelete.rawText.length) {
      newQuery += '.';
    }
    
    onChange(newQuery);
    
    // Enter edit mode and position cursor
    setIsEditing(true);
    
    setTimeout(() => {
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (!model) return;
        
        // Position cursor at the deletion point
        const cursorPos = model.getPositionAt(Math.min(startIndex, newQuery.length));
        editorRef.current.setPosition(cursorPos);
        editorRef.current.focus();
        
        // Trigger autocomplete
        setTimeout(() => {
          editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
        }, 50);
      }
    }, 100);
  };
  
  // Click outer chip to select the whole term in Monaco
  const handleOuterChipClick = (chip: ParsedQueryChip, e: React.MouseEvent) => {
    e.stopPropagation();
    if (readonly) return;
    
    console.log('[QueryExpressionEditor] Outer chip clicked:', { 
      chip: chip.rawText,
      currentValue: value 
    });
    setIsEditing(true);
    
    // Wait for editor to mount, then select the entire term
    setTimeout(() => {
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (!model) return;
        
        const fullText = model.getValue();
        const startIndex = fullText.indexOf(chip.rawText);
        if (startIndex >= 0) {
          const startPos = model.getPositionAt(startIndex);
          const endPos = model.getPositionAt(startIndex + chip.rawText.length);
          
          editorRef.current.setSelection({
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column
          });
          editorRef.current.focus();
          
          // Trigger autocomplete
          setTimeout(() => {
            editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
          }, 50);
        }
      }
    }, 100);
  };
  
  // Click inner chip to select just the ID/value in Monaco
  const handleInnerChipClick = (chip: ParsedQueryChip, valueText: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (readonly) return;
    
    console.log('[QueryExpressionEditor] Inner chip clicked:', { 
      chip: chip.rawText,
      valueText,
      currentValue: value 
    });
    setIsEditing(true);
    
    // Wait for editor to mount, then select just the value
    setTimeout(() => {
      if (editorRef.current && monacoRef.current) {
        const model = editorRef.current.getModel();
        if (!model) return;
        
        const fullText = model.getValue();
        const chipIndex = fullText.indexOf(chip.rawText);
        if (chipIndex >= 0) {
          const valueIndex = fullText.indexOf(valueText, chipIndex);
          if (valueIndex >= 0) {
            const startPos = model.getPositionAt(valueIndex);
            const endPos = model.getPositionAt(valueIndex + valueText.length);
            
            editorRef.current.setSelection({
              startLineNumber: startPos.lineNumber,
              startColumn: startPos.column,
              endLineNumber: endPos.lineNumber,
              endColumn: endPos.column
            });
            editorRef.current.focus();
            
            // Trigger autocomplete
            setTimeout(() => {
              editorRef.current?.trigger('keyboard', 'editor.action.triggerSuggest', {});
            }, 50);
          }
        }
      }
    }, 100);
  };
  
  // Chip view component
  const renderChipView = () => {
    if (chips.length === 0) {
      return (
        <div
          onClick={() => {
            if (!readonly) {
              console.log('[QueryExpressionEditor] Empty placeholder clicked, entering edit mode');
              setIsEditing(true);
            }
          }}
          style={{
            padding: '10px 12px',
            color: '#9CA3AF',
            fontSize: '13px',
            cursor: readonly ? 'default' : 'pointer',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          }}
        >
          {placeholder}
        </div>
      );
    }
    
    return (
      <div
        onClick={(e) => {
          // Only enter edit mode if clicking empty space (not a chip)
          if (e.target === e.currentTarget && !readonly) {
            console.log('[QueryExpressionEditor] Empty space clicked, entering edit mode');
            setIsEditing(true);
          }
        }}
        style={{
          padding: '6px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          cursor: readonly ? 'default' : 'text',
          minHeight: '42px',
          alignItems: 'center',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        }}
      >
        {chips.map((chip, index) => {
          const config = outerChipConfig[chip.type];
          const Icon = config.icon;
          const isHovered = hoveredChipIndex === index;
          
          // Determine inner chip type (node or case)
          const innerType = chip.type === 'case' ? 'case' : 'node';
          const innerConfig = innerChipConfig[innerType];
          
          return (
            <div
              key={index}
              onMouseEnter={() => setHoveredChipIndex(index)}
              onMouseLeave={() => setHoveredChipIndex(null)}
              onClick={(e) => handleOuterChipClick(chip, e)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '5px 8px',
                backgroundColor: '#F9FAFB',  // Neutral light grey
                borderRadius: '6px',
                border: '1px solid #D1D5DB',
                fontSize: '12px',
                fontWeight: '500',
                position: 'relative',
                transition: 'all 0.15s ease',
                cursor: readonly ? 'default' : 'pointer'
              }}
            >
              <Icon size={13} style={{ color: '#6B7280' }} />
              <span style={{ color: '#374151', fontWeight: '600' }}>
                {config.label}
              </span>
              <span style={{ color: '#6B7280' }}>(</span>
              
              {/* Inner chips for values */}
              {chip.values.map((val, vIndex) => (
                <React.Fragment key={vIndex}>
                  <div
                    onClick={(e) => handleInnerChipClick(chip, val, e)}
                    onMouseEnter={() => setHoveredInnerChip(true)}
                    onMouseLeave={() => setHoveredInnerChip(false)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '2px 6px',
                      backgroundColor: innerConfig.bgColor,
                      borderRadius: '4px',
                      border: `1px solid ${innerConfig.borderColor}`,
                      fontSize: '11px',
                      fontWeight: '500',
                      cursor: readonly ? 'default' : 'pointer',
                      position: 'relative'
                    }}
                  >
                    <span style={{ color: innerConfig.textColor }}>
                      {val}
                    </span>
                    
                    {/* Delete button on inner chip hover */}
                    {isHovered && !readonly && (
                      <button
                        type="button"
                        onClick={(e) => handleDeleteInnerChip(chip, val, vIndex, e)}
                        style={{
                          marginLeft: '4px',
                          padding: '0',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          color: innerConfig.textColor,
                          opacity: 0.5
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.5'}
                        title="Remove"
                      >
                        <X size={10} />
                      </button>
                    )}
                  </div>
                  {vIndex < chip.values.length - 1 && (
                    <span style={{ color: '#6B7280', margin: '0 2px' }}>,</span>
                  )}
                </React.Fragment>
              ))}
              
              <span style={{ color: '#6B7280' }}>)</span>
              
              {/* Delete button for entire outer chip on hover (only when not hovering inner chip) */}
              {isHovered && !hoveredInnerChip && !readonly && (
                <button
                  type="button"
                  onClick={(e) => handleDeleteChip(chip, e)}
                  style={{
                    marginLeft: '4px',
                    padding: '2px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    color: '#6B7280',
                    opacity: 0.5
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '0.5'}
                  title="Remove entire term"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  };
  
  return (
    <div style={{ 
      border: '1px solid #ddd', 
      borderRadius: '4px',
      overflow: 'visible',  // Allow autocomplete to overflow
      backgroundColor: '#ffffff',
      position: 'relative',
      zIndex: 1  // Just above normal content, but below popups/selectors
    }}>
      {/* Show chip view when not editing, Monaco when editing */}
      {!isEditing && !readonly ? (
        renderChipView()
      ) : (
        <Editor
          height={editorHeight}
          language="dagnet-query"
          value={value}
          onChange={(newValue) => {
            console.log('[QueryExpressionEditor] Monaco onChange:', { 
              newValue, 
              oldValue: value,
              isEditing 
            });
            onChange(newValue || '');
          }}
          onMount={handleEditorDidMount}
          options={{
            readOnly: readonly,
            minimap: { enabled: false },
            lineNumbers: 'off',
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 0,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            wrappingStrategy: 'advanced',
            fontSize: 13,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
            fontLigatures: false,  // Disable ligatures for clearer text
            padding: { top: 8, bottom: 8 },
            scrollbar: {
              vertical: 'auto',
              horizontal: 'hidden',
              verticalScrollbarSize: 8
            },
            quickSuggestions: true,
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: 'on',
            tabCompletion: 'on',
            wordBasedSuggestions: 'off',
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            automaticLayout: true,
            fixedOverflowWidgets: true,  // Allow suggest widget to overflow container
            suggest: {
              snippetsPreventQuickSuggestions: false,
              showKeywords: true,
              showSnippets: true
            }
          }}
        />
      )}
    </div>
  );
}

